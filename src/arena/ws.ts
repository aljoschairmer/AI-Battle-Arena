import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { Logger } from "pino";
import { child } from "../shared/logger";
import { wsProxyAgent } from "../shared/proxy";
import { TokenBucket } from "../shared/ratelimit";
import type { ClientMessage, ServerMessage } from "../types/protocol";

export interface ArenaSocketEvents {
  connected: [import("../types/protocol").ConnectedMsg];
  loadout_confirmed: [import("../types/protocol").LoadoutConfirmedMsg];
  lobby: [import("../types/protocol").LobbyMsg];
  round_start: [import("../types/protocol").RoundStartMsg];
  tick: [import("../types/protocol").TickMsg];
  kill: [import("../types/protocol").KillMsg];
  death: [import("../types/protocol").DeathMsg];
  respawn: [import("../types/protocol").RespawnMsg];
  round_end: [import("../types/protocol").RoundEndMsg];
  error: [import("../types/protocol").ErrorMsg];
  kick: [import("../types/protocol").KickMsg];
  open: [];
  close: [number, string];
}

// Server frame types we re-emit as events. The discriminant comes off the wire,
// so it MUST be whitelisted: emitting arbitrary server-provided strings on the
// EventEmitter would let a frame like {"type":"close"} or {"type":"open"} spoof
// our internal lifecycle events (a spoofed "close" schedules a reconnect while
// the real socket is still open — two live sockets, duplicate ticks).
const SERVER_MESSAGE_TYPES = new Set<string>([
  "connected",
  "loadout_confirmed",
  "lobby",
  "round_start",
  "tick",
  "kill",
  "death",
  "respawn",
  "round_end",
  "error",
  "kick",
]);

export function isServerMessageType(t: string): t is ServerMessage["type"] {
  return SERVER_MESSAGE_TYPES.has(t);
}

/**
 * Resilient WebSocket client for the arena bot endpoint.
 *
 * Responsibilities:
 *  - connect with the API key and auto-reconnect with exponential backoff
 *  - parse incoming frames into typed ServerMessages and emit per-type events
 *  - enforce the 25 msg/sec outbound cap with a token bucket so we never get
 *    kicked for flooding
 *
 * It intentionally knows nothing about strategy — it's a pure transport.
 */
export class ArenaSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private shouldRun = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  // 25/sec server cap; we self-limit to 20/sec with a burst of 6 to stay safe.
  private readonly bucket = new TokenBucket(6, 20);
  /**
   * ~4-6 queued frames (a per-tick action serializes to well under 200B).
   * Anything beyond this means the pipe is stalled and queued actions will
   * arrive stale AND as a window-blowing burst. Not an EnginePolicy knob:
   * this is a transport constant tied to the server's 25 msg/s cap, not a
   * behavior the Tuner should move.
   */
  private static readonly MAX_BUFFERED_BYTES = 1024;
  private droppedSinceLastWarn = 0;
  // Rolling 1s outbound counter — cheap telemetry proving the self-cap holds
  // under real load (visible at debug level whenever a window runs hot).
  private sentInWindow = 0;
  private windowStart = Date.now();

  private warnedUpgradeBlocked = false;
  private authSentThisConn = false;
  private gotServerMessage = false;
  private warnedBackendDown = false;
  private readonly log: Logger;

  constructor(
    private readonly wsUrl: string,
    private readonly apiKey: string,
    private readonly origin: string = "",
    // "message" (default) = direct-message auth: connect with no key, then send
    // an auth frame. "query" = the documented ?key= path — it was broken
    // server-side for a while (upgrade answered HTTP 200, not 101) but works
    // again as of 2026-07-02; message stays the default since it survived the
    // outage.
    private readonly authMode: "message" | "query" = "message",
    // Optional per-bot label so parallel bots' socket logs are distinguishable.
    private readonly label: string = "",
  ) {
    super();
    this.log = child(this.label ? `arena:ws:${this.label}` : "arena:ws");
  }

  start(): void {
    this.shouldRun = true;
    this.connect();
  }

  stop(): void {
    this.shouldRun = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close(1000, "client shutdown");
    this.ws = null;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private connect(): void {
    // Direct-message auth connects WITHOUT a key in the URL; query auth puts
    // the key on the upgrade request (both paths verified working live).
    const url =
      this.authMode === "query" && this.apiKey
        ? `${this.wsUrl}?key=${encodeURIComponent(this.apiKey)}`
        : this.wsUrl;
    this.authSentThisConn = false;
    this.gotServerMessage = false;
    this.log.info({ attempt: this.reconnectAttempts, authMode: this.authMode }, "connecting to arena");

    const ws = new WebSocket(url, {
      // Keep the socket warm; the arena AFK timeout is ~3s of game time but the
      // TCP/WS layer benefits from pings during lobby waits.
      handshakeTimeout: 10_000,
      // Honour HTTPS_PROXY when set (corporate proxies / sandboxed egress).
      // `ws` does not read proxy env vars on its own.
      agent: wsProxyAgent(this.wsUrl),
      // Present a browser-like handshake. Some edge stacks (and CDNs that emit
      // `Vary: Origin`) only complete the upgrade for requests that carry an
      // Origin and a real User-Agent — `ws` sends neither by default.
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ai-battle-arena-bot/1.0",
        ...(this.origin ? { Origin: this.origin } : {}),
      },
    });
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.log.info("websocket open");
      // Authenticate immediately via the working direct-message path. Sent
      // outside the rate limiter — this one frame must land before anything else.
      if (this.authMode === "message" && this.apiKey) {
        this.sendImmediate({ type: "auth", api_key: this.apiKey });
        this.authSentThisConn = true;
        this.log.debug("sent auth frame");
      }
      this.emit("open");
    });

    ws.on("message", (data: WebSocket.RawData) => this.onMessage(data));

    ws.on("close", (code: number, reasonBuf: Buffer) => {
      const reason = reasonBuf.toString();
      this.log.warn({ code, reason }, "websocket closed");
      // We upgraded and sent a correctly-formatted auth frame, but the arena
      // dropped the socket without ever replying (no `connected`, no error).
      // The transport + auth are correct, so this is the arena's bot backend
      // failing to accept the session — surface it clearly, once.
      if (this.authSentThisConn && !this.gotServerMessage && !this.warnedBackendDown) {
        this.warnedBackendDown = true;
        this.log.error(
          "Upgraded (101) and sent a valid auth frame, but the arena never replied with " +
            "'connected' and closed the socket. The handshake and auth format are correct, so this " +
            "is the arena's bot backend not accepting connections (matches bots_online=0 and an " +
            "empty leaderboard) — not a client-side issue. The bot will keep retrying.",
        );
      }
      this.emit("close", code, reason);
      this.ws = null;
      if (this.shouldRun) this.scheduleReconnect();
    });

    ws.on("error", (err: Error) => {
      this.log.warn({ err: err.message }, "websocket error");
      // A plain HTTP status (not 101) on the handshake means an intermediary ate
      // the upgrade. Emit an actionable, one-time diagnostic instead of letting
      // the user stare at a cryptic reconnect loop.
      if (!this.warnedUpgradeBlocked && /Unexpected server response: \d+/.test(err.message)) {
        this.warnedUpgradeBlocked = true;
        const hint =
          this.authMode === "query"
            ? "ARENA_WS_AUTH=query puts the key on the upgrade request; a non-101 response here " +
              "usually means a WebSocket-blocking proxy or an arena-side regression of the ?key= " +
              "path (it has broken before). Try ARENA_WS_AUTH=message (the default)."
            : "Using direct-message auth, the handshake upgrades without a key, so a non-101 here " +
              "points to a WebSocket-blocking proxy (e.g. Zscaler SSL inspection). Exempt " +
              "arena.angel-serv.com from SSL inspection, run off the inspected network, or set " +
              "HTTPS_PROXY to a proxy that tunnels WebSockets. REST features are unaffected.";
        this.log.error({ err: err.message }, `WebSocket upgrade was refused (no 101 Switching Protocols). ${hint}`);
      }
      // 'close' fires after 'error'; reconnect is handled there.
    });

    ws.on("ping", () => ws.pong());
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(1000 * 2 ** Math.min(this.reconnectAttempts, 5), 30_000);
    const jitter = Math.floor(Math.random() * 500);
    this.log.info({ delayMs: delay + jitter }, "scheduling reconnect");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldRun) this.connect();
    }, delay + jitter);
  }

  private onMessage(data: WebSocket.RawData): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data.toString()) as ServerMessage;
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, "failed to parse server frame");
      return;
    }
    this.gotServerMessage = true;
    const type = (msg as { type?: unknown } | null)?.type;
    if (typeof type !== "string") return;
    if (!isServerMessageType(type)) {
      this.log.debug({ type }, "ignoring unknown server frame type");
      return;
    }
    // Re-emit as a typed, per-type event. Listeners attach via on('tick', ...).
    // Use the base emitter directly: the discriminant is only known at runtime,
    // so the strongly-typed override can't narrow it here.
    super.emit(type, msg);
  }

  /**
   * Send a client message, subject to the rate limiter. Returns false if the
   * message was dropped (socket closed or budget exhausted). Per-tick actions
   * are fine to drop occasionally — the next tick supersedes them anyway.
   */
  send(msg: ClientMessage): boolean {
    if (!this.isOpen || !this.ws) return false;
    // Transport stall guard (pass-3 live finding): when the socket/proxy pipe
    // stalls, frames queued behind it are eventually flushed as one burst —
    // observed live as 40 frames landing in ~35ms, blowing the server's
    // 25 msg/s sliding window and getting the next several SECONDS of fresh
    // actions rejected (WS_RATE_LIMITED, current_count=25). A per-tick action
    // computed even half a second ago is worthless on delivery, so when the
    // pipe is backed up beyond a few frames, drop instead of queue — the next
    // tick supersedes it, and the fresh action after the stall actually lands.
    if (this.ws.bufferedAmount > ArenaSocket.MAX_BUFFERED_BYTES) {
      this.droppedSinceLastWarn += 1;
      if (this.droppedSinceLastWarn % 20 === 1) {
        this.log.warn(
          { buffered: this.ws.bufferedAmount, dropped: this.droppedSinceLastWarn },
          "socket backlogged — dropping stale per-tick action instead of queueing",
        );
      }
      return false;
    }
    if (!this.bucket.tryTake(1)) {
      this.droppedSinceLastWarn += 1;
      if (this.droppedSinceLastWarn % 20 === 1) {
        this.log.debug({ dropped: this.droppedSinceLastWarn }, "rate limiter dropping messages");
      }
      return false;
    }
    try {
      this.ws.send(JSON.stringify(msg));
      this.countSent();
      return true;
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, "send failed");
      return false;
    }
  }

  private countSent(): void {
    const now = Date.now();
    if (now - this.windowStart >= 1000) {
      if (this.sentInWindow > 15) {
        this.log.debug({ perSec: this.sentInWindow }, "outbound rate (rolling 1s window)");
      }
      this.sentInWindow = 0;
      this.windowStart = now;
    }
    this.sentInWindow += 1;
  }

  /** Send a critical control frame (e.g. auth) bypassing the rate limiter. */
  private sendImmediate(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, "immediate send failed");
    }
  }

  // Strongly-typed event registration sugar.
  override on<K extends keyof ArenaSocketEvents>(
    event: K,
    listener: (...args: ArenaSocketEvents[K]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override emit<K extends keyof ArenaSocketEvents>(
    event: K,
    ...args: ArenaSocketEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }
}
