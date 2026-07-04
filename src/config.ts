import "dotenv/config";
import { z } from "zod";

/**
 * Centralised, validated runtime configuration. Parsed once at process start;
 * fail fast on bad input rather than discovering it deep in the tick loop.
 */

const RoleSchema = z.enum(["engine", "brain", "all"]);
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

// One key per bot. ARENA_API_KEYS (comma-separated) runs several bots in
// parallel; otherwise fall back to the single ARENA_API_KEY.
function csv(name: string): string[] {
  return str(name)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
const apiKeys: string[] = (() => {
  const many = csv("ARENA_API_KEYS");
  if (many.length) return many;
  const one = str("ARENA_API_KEY");
  return one ? [one] : [];
})();
const botNameBase = str("BOT_NAME", "NeuralReaper");
// Per-bot names for multi-key fleets (BOT_NAMES=Alpha,Beta,Gamma). Positional
// with ARENA_API_KEYS; any missing position falls back to BOT_NAME-<n>.
const botNames = csv("BOT_NAMES");
const botColorBase = str("BOT_COLOR", "#00d4ff");
const BOT_PALETTE = ["#00d4ff", "#ff5252", "#7c4dff", "#00e676", "#ffab00", "#ff4081", "#18ffff", "#c6ff00"];

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
  return {
    index: i,
    apiKey: key,
    name: botNames[i] ?? (multi ? `${botNameBase}-${i + 1}` : botNameBase),
    color: multi ? (BOT_PALETTE[i % BOT_PALETTE.length] as string) : botColorBase,
    scope: multi ? `bot${i}:` : "",
  };
});

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
    // auth, which works; "query" = the documented ?key= path, broken server-side.
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
      strategist: str("OPENROUTER_MODEL_STRATEGIST", "anthropic/claude-sonnet-4.6"),
      loadout: str("OPENROUTER_MODEL_LOADOUT", "anthropic/claude-sonnet-4.6"),
      tactician: str("OPENROUTER_MODEL_TACTICIAN", "anthropic/claude-haiku-4.5"),
      coordinator: str("OPENROUTER_MODEL_COORDINATOR", "anthropic/claude-sonnet-4.6"),
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

export function assertConfigForRole(): void {
  if (runsEngine && config.arena.bots.length === 0) {
    throw new Error(
      "No bot key configured. Set ARENA_API_KEY (single bot) or ARENA_API_KEYS=key1,key2,... " +
        "(multiple bots in parallel). Generate keys with `npm run keygen`.",
    );
  }
  if (role !== "all" && bus === "memory") {
    throw new Error(
      `BUS=memory only works with ROLE=all (engine and brain in one process). ` +
        `Current ROLE=${role}. Use BUS=redis to split the workers across processes.`,
    );
  }
}
