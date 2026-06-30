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

export const config = {
  role,
  bus,

  arena: {
    httpBase: str("ARENA_HTTP_BASE", "https://arena.angel-serv.com").replace(/\/$/, ""),
    wsUrl: str("ARENA_WS_URL", "wss://arena.angel-serv.com/ws/bot"),
    apiKey: str("ARENA_API_KEY"),
    botName: str("BOT_NAME", "NeuralReaper"),
    botColor: str("BOT_COLOR", "#00d4ff"),
  },

  redis: {
    url: str("REDIS_URL", "redis://127.0.0.1:6379"),
  },

  openrouter: {
    apiKey: str("OPENROUTER_API_KEY"),
    base: str("OPENROUTER_BASE", "https://openrouter.ai/api/v1").replace(/\/$/, ""),
    siteUrl: str("OPENROUTER_SITE_URL", "https://arena.angel-serv.com"),
    appName: str("OPENROUTER_APP_NAME", "ai-battle-arena-bot"),
    models: {
      strategist: str("OPENROUTER_MODEL_STRATEGIST", "anthropic/claude-3.5-sonnet"),
      loadout: str("OPENROUTER_MODEL_LOADOUT", "anthropic/claude-3.5-sonnet"),
      tactician: str("OPENROUTER_MODEL_TACTICIAN", "openai/gpt-4o-mini"),
    },
    tacticianIntervalMs: int("TACTICIAN_INTERVAL_MS", 2500),
    timeoutMs: int("LLM_TIMEOUT_MS", 8000),
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
  if (runsEngine && !config.arena.apiKey) {
    throw new Error(
      "ARENA_API_KEY is required to run the engine. Generate one with `npm run keygen` " +
        "or POST https://arena.angel-serv.com/api/v1/keys/generate, then set it in .env.",
    );
  }
  if (role === "all" && bus === "redis") {
    // Allowed, but unusual — warn-worthy. Both workers will share one Redis.
  }
  if (role !== "all" && bus === "memory") {
    throw new Error(
      `BUS=memory only works with ROLE=all (engine and brain in one process). ` +
        `Current ROLE=${role}. Use BUS=redis to split the workers across processes.`,
    );
  }
}
