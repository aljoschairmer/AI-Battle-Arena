import WebSocket from "ws";
import { config } from "../config";
import { child } from "../shared/logger";
import { wsProxyAgent } from "../shared/proxy";
import type { GridVec, SpectatorArenaState, SpectatorBot } from "../types/protocol";

const log = child("arena:spectator");

/** World units per grid tile (arena constant; 2000x2000 world / 100x100 grid). */
const CELL = 20;

/**
 * Read-only client for the public spectator feed (WS /ws/spectator, no auth).
 *
 * Every tick the arena broadcasts ONE `arena_state` frame with the FULL global
 * state — every bot's live position/hp/target, every landmine (position +
 * owner + armed, which bot fog deliberately hides!), all pickups, pads and
 * hazards, kill feed, sudden_death (pass-4 API audit, finding 6). It is a
 * fog-of-war bypass the arena itself publishes.
 *
 * Consumed by BOTH layers, differently: the Brain gets intel() folded into
 * strategy prompts; the Engine reads engineIntel() at the top of each tick —
 * a cached-property read, no I/O, never a second dependency on the socket
 * being up (absent/stale frames return null and the engine plays fog-only).
 * Frames arrive at 10 Hz (~17 KB); we simply keep the latest one — no queue,
 * no parsing beyond JSON, so the cost is negligible.
 */
export class SpectatorFeed {
  private ws: WebSocket | null = null;
  private shouldRun = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private state: SpectatorArenaState | null = null;
  private stateTs = 0;
  private frameHandlers: Array<(s: SpectatorArenaState) => void> = [];

  constructor(private readonly url: string = deriveSpectatorUrl()) {}

  /**
   * Subscribe to EVERY incoming frame (the cached `latest()` only keeps the
   * newest one — right for live intel, useless for the Scout, which needs
   * lossless kill-feed/movement streams). Handlers must be cheap and never
   * throw (they run on the WS message path); throws are swallowed per call.
   * Returns an unsubscribe function.
   */
  onFrame(handler: (s: SpectatorArenaState) => void): () => void {
    this.frameHandlers.push(handler);
    return () => {
      this.frameHandlers = this.frameHandlers.filter((h) => h !== handler);
    };
  }

  start(): void {
    if (this.shouldRun) return;
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

  /** Latest arena_state frame, or null when none fresh within `maxAgeMs`. */
  latest(maxAgeMs = 3000): SpectatorArenaState | null {
    if (!this.state) return null;
    if (Date.now() - this.stateTs > maxAgeMs) return null;
    return this.state;
  }

  /**
   * Compact global-intel summary for LLM prompts: the aggro graph (who is
   * locked onto whom, by name), every living bot's position/hp, armed mines
   * near us, and the sudden-death flag. `selfId` marks our own bot so the
   * summary can call out who is hunting US specifically.
   */
  intel(selfId: string, selfPos?: GridVec): SpectatorIntel | null {
    const s = this.latest();
    if (!s) return null;
    // Spectator frames use WORLD units (0..1999); everything else in the bot
    // (snapshots, directives) is grid tiles (0..99). Convert here so the two
    // never mix downstream. `selfPos` is expected in GRID coordinates.
    const toGrid = (p: GridVec): GridVec => [Math.round(p[0] / CELL), Math.round(p[1] / CELL)];
    // Empty collections are OMITTED from frames (not sent as []) — verified
    // live: a frame with no landmines has no `landmines` key at all.
    const alive = (s.bots ?? []).filter((b) => b.is_alive);
    const byId = new Map<string, SpectatorBot>(alive.map((b) => [b.id, b]));
    const name = (id: string): string => byId.get(id)?.name ?? id.slice(0, 8);

    const bots = alive.map((b) => ({
      id: b.id,
      name: b.name,
      weapon: b.weapon,
      hp: Math.round(b.hp),
      maxHp: b.max_hp,
      position: toGrid(b.position),
      targeting: b.target_id ? (b.target_id === selfId ? "US" : name(b.target_id)) : null,
      isBountyTarget: b.is_bounty_target === true,
      killStreak: b.kill_streak,
    }));

    const huntingUs = alive
      .filter((b) => b.id !== selfId && b.target_id === selfId)
      .map((b) => b.name);

    // Armed mines within ~12 tiles of us (bot fog NEVER shows enemy mines —
    // this is the only source): worth flagging so strategy can route around.
    const minesNearUs = selfPos
      ? (s.landmines ?? [])
          .filter((m) => m.armed && m.owner_id !== selfId)
          .map((m) => {
            const g = toGrid(m.position);
            return {
              position: g,
              distance: Math.round(Math.hypot(g[0] - selfPos[0], g[1] - selfPos[1]) * 10) / 10,
            };
          })
          .filter((m) => m.distance <= 12)
          .sort((a, b) => a.distance - b.distance)
          .slice(0, 6)
      : [];

    return {
      tick: s.tick,
      suddenDeath: s.sudden_death === true,
      botsAlive: alive.length,
      bots: bots.slice(0, 16),
      huntingUs,
      minesNearUs,
    };
  }

  /**
   * Compact fog-free view for the ENGINE's deterministic layer (grid coords):
   * every armed mine with its owner (fog NEVER shows enemy mines) and every
   * other living bot's position/weapon/target. Null when the feed is absent
   * or stale (>3s) — callers must degrade to fog-only behaviour on null.
   * Pure transform of the cached frame: safe to call on the 10 Hz tick path.
   */
  engineIntel(selfId: string): EngineGlobalIntel | null {
    const s = this.latest();
    if (!s || !selfId) return null;
    const toGrid = (p: GridVec): GridVec => [Math.round(p[0] / CELL), Math.round(p[1] / CELL)];
    const mines = (s.landmines ?? [])
      .filter((m) => m.armed && m.owner_id !== selfId)
      .map((m) => ({ pos: toGrid(m.position), ownerId: m.owner_id }));
    const bots = (s.bots ?? [])
      .filter((b) => b.is_alive && b.id !== selfId)
      .map((b) => ({
        id: b.id,
        weapon: b.weapon,
        pos: toGrid(b.position),
        hp: Math.round(b.hp),
        targetId: b.target_id || null,
        // Server team (0 in FFA): lets GameState exclude teammates from the
        // hunter/aggro sets in team modes.
        team: b.team ?? 0,
      }));
    return { tick: s.tick, mines, bots };
  }

  private connect(): void {
    log.debug({ attempt: this.reconnectAttempts, url: this.url }, "connecting spectator feed");
    const ws = new WebSocket(this.url, {
      handshakeTimeout: 10_000,
      agent: wsProxyAgent(this.url),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ai-battle-arena-bot/1.0",
        ...(config.arena.wsOrigin ? { Origin: config.arena.wsOrigin } : {}),
      },
    });
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempts = 0;
      log.info("spectator feed connected");
    });
    ws.on("message", (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as { type?: string };
        if (msg.type === "arena_state") {
          const frame = msg as SpectatorArenaState;
          // Keyframe rule (bot guide): `obstacles` is only included on every
          // 10th broadcast (and right after connect) — between keyframes the
          // field is OMITTED. Carry the last received copy forward instead of
          // clearing the map for 9 of every 10 frames.
          if (!frame.obstacles && this.state?.obstacles) frame.obstacles = this.state.obstacles;
          this.state = frame;
          this.stateTs = Date.now();
          for (const h of this.frameHandlers) {
            try {
              h(this.state);
            } catch {
              /* a scout bug must never take the shared feed down */
            }
          }
        } else if (msg.type === "heartbeat") {
          // ~10s application-level heartbeat, sent even while a paused game
          // produces no arena snapshots. No gameplay state — connection
          // health only. Deliberately does NOT refresh stateTs: a paused
          // game's stale positions must still expire out of latest().
          log.debug({ paused: (msg as { paused?: boolean }).paused === true }, "spectator heartbeat");
        } else if (msg.type === "service_status") {
          // Operator broadcast / maintenance control frame — routed separately
          // from render state per the guide; the bot socket handles reconnect
          // timing, so the spectator feed just surfaces it at debug.
          log.debug("spectator service_status frame");
        }
        // Other unknown types: ignore silently (forward compatibility).
      } catch {
        /* malformed frame — keep the previous state */
      }
    });
    ws.on("close", (code: number) => {
      log.debug({ code }, "spectator feed closed");
      this.ws = null;
      if (this.shouldRun) this.scheduleReconnect();
    });
    ws.on("error", (err: Error) => {
      // Best-effort intel: never noisy. close fires after error and reconnects.
      log.debug({ err: err.message }, "spectator feed error");
    });
    ws.on("ping", () => ws.pong());
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(2000 * 2 ** Math.min(this.reconnectAttempts, 5), 60_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldRun) this.connect();
    }, delay);
  }
}

export interface SpectatorIntel {
  tick: number;
  suddenDeath: boolean;
  botsAlive: number;
  bots: {
    id: string;
    name: string;
    weapon: string;
    hp: number;
    maxHp: number;
    position: GridVec;
    /** Who they're locked onto: "US", another bot's name, or null. */
    targeting: string | null;
    isBountyTarget: boolean;
    killStreak: number;
  }[];
  /** Names of bots whose live target is us. */
  huntingUs: string[];
  /** Armed enemy mines within ~12 tiles of us — invisible in bot fog. */
  minesNearUs: { position: GridVec; distance: number }[];
}

/** Fog-free per-tick view for the Engine (grid coordinates throughout). */
export interface EngineGlobalIntel {
  tick: number;
  /** Every armed mine on the field that isn't ours, with its owner's bot_id. */
  mines: { pos: GridVec; ownerId: string }[];
  /** Every other living bot: live position, weapon, and who it's locked onto. */
  bots: { id: string; weapon: string; pos: GridVec; hp: number; targetId: string | null; team?: number }[];
}

function deriveSpectatorUrl(): string {
  // ARENA_WS_URL points at /ws/bot; the spectator endpoint lives beside it.
  const botUrl = config.arena.wsUrl;
  if (botUrl.endsWith("/ws/bot")) return `${botUrl.slice(0, -"/ws/bot".length)}/ws/spectator`;
  return "wss://arena.angel-serv.com/ws/spectator";
}

// One feed per process regardless of how many bots/orchestrators run in it —
// the frames are global, so N connections would be N copies of the same data.
let shared: SpectatorFeed | null = null;

/** Process-wide shared feed (started lazily), or null when disabled via env. */
export function getSpectatorFeed(): SpectatorFeed | null {
  if (process.env.ARENA_SPECTATOR?.toLowerCase() === "false") return null;
  if (!shared) {
    shared = new SpectatorFeed();
    shared.start();
  }
  return shared;
}
