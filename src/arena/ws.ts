import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { child } from "../shared/logger";
import { wsProxyAgent } from "../shared/proxy";
import { TokenBucket } from "../shared/ratelimit";
import type { ClientMessage, ServerMessage } from "../types/protocol";

const log = child("arena:ws");

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
  private droppedSinceLastWarn = 0;

  private warnedUpgradeBlocked = false;

  constructor(
    private readonly wsUrl: string,
    private readonly apiKey: string,
    private readonly origin: string = "",
    // "message" (default) = direct-message auth: connect with no key, then send
    // an auth frame. "query" = legacy ?key= path (broken server-side; kept for
    // when/if the arena fixes it).
    private readonly authMode: "message" | "query" = "message",
  ) {
    super();
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
    // Direct-message auth connects WITHOUT a key in the URL (the ?key= path is
    // broken server-side and refuses the upgrade with HTTP 200).
    const url =
      this.authMode === "query" && this.apiKey
        ? `${this.wsUrl}?key=${encodeURIComponent(this.apiKey)}`
        : this.wsUrl;
    log.info({ attempt: this.reconnectAttempts, authMode: this.authMode }, "connecting to arena");

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
      log.info("websocket open");
      // Authenticate immediately via the working direct-message path. Sent
      // outside the rate limiter — this one frame must land before anything else.
      if (this.authMode === "message" && this.apiKey) {
        this.sendImmediate({ type: "auth", api_key: this.apiKey });
        log.debug("sent auth frame");
      }
      this.emit("open");
    });

    ws.on("message", (data: WebSocket.RawData) => this.onMessage(data));

    ws.on("close", (code: number, reasonBuf: Buffer) => {
      const reason = reasonBuf.toString();
      log.warn({ code, reason }, "websocket closed");
      this.emit("close", code, reason);
      this.ws = null;
      if (this.shouldRun) this.scheduleReconnect();
    });

    ws.on("error", (err: Error) => {
      log.warn({ err: err.message }, "websocket error");
      // A plain HTTP status (not 101) on the handshake means an intermediary ate
      // the upgrade. Emit an actionable, one-time diagnostic instead of letting
      // the user stare at a cryptic reconnect loop.
      if (!this.warnedUpgradeBlocked && /Unexpected server response: \d+/.test(err.message)) {
        this.warnedUpgradeBlocked = true;
        const hint =
          this.authMode === "query"
            ? "ARENA_WS_AUTH=query uses the arena's ?key= path, which is broken server-side " +
              "(it returns HTTP 200 instead of 101). Switch to ARENA_WS_AUTH=message (the default)."
            : "Using direct-message auth, the handshake upgrades without a key, so a non-101 here " +
              "points to a WebSocket-blocking proxy (e.g. Zscaler SSL inspection). Exempt " +
              "arena.angel-serv.com from SSL inspection, run off the inspected network, or set " +
              "HTTPS_PROXY to a proxy that tunnels WebSockets. REST features are unaffected.";
        log.error({ err: err.message }, `WebSocket upgrade was refused (no 101 Switching Protocols). ${hint}`);
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
    log.info({ delayMs: delay + jitter }, "scheduling reconnect");
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
      log.warn({ err: (e as Error).message }, "failed to parse server frame");
      return;
    }
    if (!msg || typeof (msg as { type?: unknown }).type !== "string") return;
    // Re-emit as a typed, per-type event. Listeners attach via on('tick', ...).
    // Use the base emitter directly: the discriminant is only known at runtime,
    // so the strongly-typed override can't narrow it here.
    super.emit(msg.type, msg);
  }

  /**
   * Send a client message, subject to the rate limiter. Returns false if the
   * message was dropped (socket closed or budget exhausted). Per-tick actions
   * are fine to drop occasionally — the next tick supersedes them anyway.
   */
  send(msg: ClientMessage): boolean {
    if (!this.isOpen || !this.ws) return false;
    if (!this.bucket.tryTake(1)) {
      this.droppedSinceLastWarn += 1;
      if (this.droppedSinceLastWarn % 20 === 1) {
        log.debug({ dropped: this.droppedSinceLastWarn }, "rate limiter dropping messages");
      }
      return false;
    }
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      log.warn({ err: (e as Error).message }, "send failed");
      return false;
    }
  }

  /** Send a critical control frame (e.g. auth) bypassing the rate limiter. */
  private sendImmediate(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (e) {
      log.warn({ err: (e as Error).message }, "immediate send failed");
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
