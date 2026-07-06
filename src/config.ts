import "dotenv/config";
import { z } from "zod";

/**
 * Centralised, validated runtime configuration. Parsed once at process start;
 * fail fast on bad input rather than discovering it deep in the tick loop.
 */

const RoleSchema = z.enum(["engine", "brain", "all", "scout"]);
const BusSchema = z.enum(["redis", "memory"]);

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    return "";
  }
  return v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

const role = RoleSchema.parse(str("ROLE", "all"));
const bus = BusSchema.parse(str("BUS", "memory"));
const arenaHttpBase = str("ARENA_HTTP_BASE", "https://arena.angel-serv.com").replace(/\/$/, "");

/**
 * Non-fatal configuration problems, surfaced by main() once the logger exists.
 * (config.ts cannot log directly — logger.ts imports this module.)
 */
export const configWarnings: string[] = [];

// One key per bot. ARENA_API_KEYS (comma-separated) runs several bots in
// parallel; otherwise fall back to the single ARENA_API_KEY.
function csv(name: string): string[] {
  return str(name)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Positional variant for per-bot lists (BOT_NAMES/BOT_COLORS): empty slots are
// KEPT so entries stay aligned with ARENA_API_KEYS ("Alpha,,Gamma" leaves bot 2
// on its default). csv() would silently shift everything left.
function csvAligned(name: string): string[] {
  const raw = str(name);
  if (!raw.trim()) return [];
  return raw.split(",").map((s) => s.trim());
}

const apiKeys: string[] = (() => {
  const many = csv("ARENA_API_KEYS");
  if (many.length) return many;
  const one = str("ARENA_API_KEY");
  return one ? [one] : [];
})();

/**
 * Normalise a colour to "#rrggbb"/"#rgb"; null when empty or not valid hex.
 * Accepts the bare form ("00d4ff") because dotenv treats an unquoted `#` as a
 * comment start — `BOT_COLOR=#00d4ff` in a .env file reads back as EMPTY, so
 * the #-less spelling is the one that survives a round-trip.
 */
function normalizeColor(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const v = t.startsWith("#") ? t : `#${t}`;
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v) ? v.toLowerCase() : null;
}

const botNameRaw = str("BOT_NAME");
const botNameBase = botNameRaw.trim() || "NeuralReaper";
if (botNameRaw && !botNameRaw.trim()) {
  configWarnings.push(`BOT_NAME is whitespace-only — using "${botNameBase}"`);
}

const botColorRaw = str("BOT_COLOR");
const botColorBase = (() => {
  const n = normalizeColor(botColorRaw);
  if (n) return n;
  if (botColorRaw.trim()) {
    configWarnings.push(`BOT_COLOR="${botColorRaw}" is not a hex colour (#rgb/#rrggbb, # optional) — using #00d4ff`);
  }
  return "#00d4ff";
})();

const BOT_PALETTE = ["#00d4ff", "#ff5252", "#7c4dff", "#00e676", "#ffab00", "#ff4081", "#18ffff", "#c6ff00"];

// Optional per-bot identity for multi-key runs, aligned by position with
// ARENA_API_KEYS. Any missing/empty slot falls back to the derived default
// (BOT_NAME-<n> and the palette colour).
const botNameOverrides = csvAligned("BOT_NAMES");
const botColorOverrides = csvAligned("BOT_COLORS");
if (botNameOverrides.length > apiKeys.length) {
  configWarnings.push(`BOT_NAMES has ${botNameOverrides.length} entries but only ${apiKeys.length} API key(s) — extra names ignored`);
}
if (botColorOverrides.length > apiKeys.length) {
  configWarnings.push(`BOT_COLORS has ${botColorOverrides.length} entries but only ${apiKeys.length} API key(s) — extra colours ignored`);
}

export interface BotInstance {
  index: number;
  apiKey: string;
  name: string;
  color: string;
  /** Bus channel/KV prefix isolating this bot ("" for a lone bot). */
  scope: string;
}

const botInstances: BotInstance[] = apiKeys.map((key, i) => {
  const multi = apiKeys.length > 1;
  const nameOverride = botNameOverrides[i] ?? "";
  const colorRawOverride = botColorOverrides[i] ?? "";
  const colorOverride = normalizeColor(colorRawOverride);
  if (colorRawOverride && !colorOverride) {
    configWarnings.push(`BOT_COLORS entry ${i + 1} ("${colorRawOverride}") is not a hex colour — using default for bot ${i + 1}`);
  }
  return {
    index: i,
    apiKey: key,
    name: nameOverride || (multi ? `${botNameBase}-${i + 1}` : botNameBase),
    color: colorOverride ?? (multi ? (BOT_PALETTE[i % BOT_PALETTE.length] as string) : botColorBase),
    scope: multi ? `bot${i}:` : "",
  };
});

// Bot names must be unique within our own fleet: each one registers its name
// via PUT /bot/config, round_winner comes back as a name, and coalition/opponent
// bookkeeping keys on names. Disambiguate collisions instead of letting two of
// our bots shadow each other.
{
  const used = new Set<string>();
  for (const b of botInstances) {
    let name = b.name;
    for (let n = 2; used.has(name); n++) name = `${b.name}-${n}`;
    if (name !== b.name) {
      configWarnings.push(`duplicate bot name "${b.name}" — bot ${b.index + 1} renamed to "${name}"`);
      b.name = name;
    }
    used.add(name);
  }
}

export const config = {
  role,
  bus,

  arena: {
    httpBase: arenaHttpBase,
    wsUrl: str("ARENA_WS_URL", "wss://arena.angel-serv.com/ws/bot"),
    // Some edge/proxy stacks only perform the WebSocket upgrade when a browser-like
    // Origin is present (the arena responds with `Vary: Origin`). Default to the
    // HTTP origin; override with ARENA_WS_ORIGIN if needed.
    wsOrigin: str("ARENA_WS_ORIGIN", arenaHttpBase),
    // Auth method for the bot WebSocket. "message" (default) = direct-message
    // auth; "query" = the documented ?key= path. Both verified working live
    // (2026-07-02); message stays default as it survived the arena's earlier
    // ?key= outage.
    wsAuth: (str("ARENA_WS_AUTH", "message") === "query" ? "query" : "message") as "message" | "query",
    // First key kept for back-compat/single-bot; `bots` is the full list.
    apiKey: apiKeys[0] ?? "",
    botName: botNameBase,
    botColor: botColorBase,
    bots: botInstances,
  },

  redis: {
    url: str("REDIS_URL", "redis://127.0.0.1:6379"),
  },

  // Bot-to-bot cooperation: when enabled, all of OUR parallel bots form a
  // coalition — they don't attack each other, they focus-fire a shared target,
  // and they share enemy intel over a global bus channel.
  coop: {
    enabled: str("BOT_COOP", "false").toLowerCase() === "true",
    // How often the (single, squad-wide) Coordinator brain re-evaluates
    // focus-fire + roles. Infrequent by design — it reasons over pooled coop
    // intel, not the hot path.
    coordinatorIntervalMs: int("COOP_COORDINATOR_INTERVAL_MS", 3000),
  },

  openrouter: {
    apiKey: str("OPENROUTER_API_KEY"),
    base: str("OPENROUTER_BASE", "https://openrouter.ai/api/v1").replace(/\/$/, ""),
    siteUrl: str("OPENROUTER_SITE_URL", "https://arena.angel-serv.com"),
    appName: str("OPENROUTER_APP_NAME", "ai-battle-arena-bot"),
    models: {
      // Free-tier defaults: the account ran out of OpenRouter credits mid-pass
      // and every paid call 402'd. The deterministic evidence enforcement in
      // the orchestrator covers for weaker draft compliance; set the env vars
      // to paid models when credits are available.
      strategist: str("OPENROUTER_MODEL_STRATEGIST", "qwen/qwen3-next-80b-a3b-instruct:free"),
      loadout: str("OPENROUTER_MODEL_LOADOUT", "qwen/qwen3-next-80b-a3b-instruct:free"),
      tactician: str("OPENROUTER_MODEL_TACTICIAN", "qwen/qwen3-next-80b-a3b-instruct:free"),
      coordinator: str("OPENROUTER_MODEL_COORDINATOR", "qwen/qwen3-next-80b-a3b-instruct:free"),
    },
    tacticianIntervalMs: int("TACTICIAN_INTERVAL_MS", 2500),
    // Floor of 1s: a zero/negative timeout (typo'd env) would abort every LLM
    // call instantly and silently reduce the brain to pure fallback logic.
    timeoutMs: Math.max(1000, int("LLM_TIMEOUT_MS", 8000)),
  },

  log: {
    level: str("LOG_LEVEL", "info"),
    format: str("LOG_FORMAT", "pretty"),
  },
} as const;

export type AppConfig = typeof config;

/** True when the LLM brain has the credentials it needs to actually run. */
export const llmEnabled = config.openrouter.apiKey.length > 0;

/** True when this process should run the real-time combat engine. */
export const runsEngine = role === "engine" || role === "all";

/** True when this process should run the LLM strategy brain. */
export const runsBrain = role === "brain" || role === "all";

/** True for the passive spectator scout (no keys, no bus, no LLM needed). */
export const runsScout = role === "scout";

export function assertConfigForRole(): void {
  if (runsEngine && config.arena.bots.length === 0) {
    throw new Error(
      "No bot key configured. Set ARENA_API_KEY (single bot) or ARENA_API_KEYS=key1,key2,... " +
        "(multiple bots in parallel). Generate keys with `npm run keygen`.",
    );
  }
  // The scout is bus-less (it only reads the public spectator WS), so the
  // memory-bus topology constraint doesn't apply to it.
  if (role !== "all" && role !== "scout" && bus === "memory") {
    throw new Error(
      `BUS=memory only works with ROLE=all (engine and brain in one process). ` +
        `Current ROLE=${role}. Use BUS=redis to split the workers across processes.`,
    );
  }
}
