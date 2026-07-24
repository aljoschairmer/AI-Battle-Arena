/**
 * config.ts parses process.env once at import time, so every case here resets
 * the module registry, stubs the env, and re-imports a fresh copy.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const BASE_ENV: Record<string, string> = {
  ROLE: "all",
  BUS: "memory",
  ARENA_API_KEY: "",
  ARENA_API_KEYS: "",
  BOT_NAME: "",
  BOT_NAMES: "",
  BOT_COLOR: "",
  BOT_COLORS: "",
};

async function loadConfig(env: Record<string, string> = {}): Promise<typeof import("../src/config")> {
  vi.resetModules();
  for (const [k, v] of Object.entries({ ...BASE_ENV, ...env })) vi.stubEnv(k, v);
  return import("../src/config");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("defaults", () => {
  it("runs ROLE=all on the memory bus with the default identity", async () => {
    const { config } = await loadConfig();
    expect(config.role).toBe("all");
    expect(config.bus).toBe("memory");
    expect(config.arena.botName).toBe("NeuralReaper");
    expect(config.arena.botColor).toBe("#00d4ff");
  });

  it("rejects an unknown ROLE outright", async () => {
    await expect(loadConfig({ ROLE: "warlord" })).rejects.toThrow();
  });
});

describe("fleet parsing (ARENA_API_KEYS)", () => {
  it("derives per-bot identity, palette colour, and isolated bus scope", async () => {
    const { config } = await loadConfig({ ARENA_API_KEYS: "k1, k2 ,k3" });
    expect(config.arena.bots).toHaveLength(3);
    expect(config.arena.bots.map((b) => b.apiKey)).toEqual(["k1", "k2", "k3"]);
    expect(config.arena.bots.map((b) => b.name)).toEqual(["NeuralReaper-1", "NeuralReaper-2", "NeuralReaper-3"]);
    expect(config.arena.bots.map((b) => b.scope)).toEqual(["bot0:", "bot1:", "bot2:"]);
    // First key stays exposed for single-bot back-compat.
    expect(config.arena.apiKey).toBe("k1");
  });

  it("keeps positional alignment for BOT_NAMES with empty slots", async () => {
    const { config } = await loadConfig({ ARENA_API_KEYS: "k1,k2,k3", BOT_NAMES: "Alpha,,Gamma" });
    expect(config.arena.bots.map((b) => b.name)).toEqual(["Alpha", "NeuralReaper-2", "Gamma"]);
  });

  it("disambiguates duplicate bot names and records a warning", async () => {
    const mod = await loadConfig({ ARENA_API_KEYS: "k1,k2", BOT_NAMES: "Twin,Twin" });
    const names = mod.config.arena.bots.map((b) => b.name);
    expect(new Set(names).size).toBe(2);
    expect(mod.configWarnings.some((w) => /duplicate bot name/.test(w))).toBe(true);
  });

  it("falls back to the single ARENA_API_KEY when no list is set", async () => {
    const { config } = await loadConfig({ ARENA_API_KEY: "solo" });
    expect(config.arena.bots).toHaveLength(1);
    expect(config.arena.bots[0]!.scope).toBe(""); // lone bot = unscoped bus
  });
});

describe("colour normalisation", () => {
  it("accepts bare hex (the only spelling that survives dotenv's # handling)", async () => {
    const { config } = await loadConfig({ BOT_COLOR: "ff5252" });
    expect(config.arena.botColor).toBe("#ff5252");
  });

  it("falls back to the default and warns on a non-hex colour", async () => {
    const mod = await loadConfig({ BOT_COLOR: "reddish" });
    expect(mod.config.arena.botColor).toBe("#00d4ff");
    expect(mod.configWarnings.some((w) => /BOT_COLOR/.test(w))).toBe(true);
  });
});

describe("assertConfigForRole", () => {
  it("throws when an engine role has no API key at all", async () => {
    const mod = await loadConfig({ ROLE: "engine", BUS: "redis" });
    expect(() => mod.assertConfigForRole()).toThrow(/No bot key configured/);
  });

  it("throws for a split role on the memory bus", async () => {
    const mod = await loadConfig({ ROLE: "brain", BUS: "memory" });
    expect(() => mod.assertConfigForRole()).toThrow(/BUS=memory only works with ROLE=all/);
  });

  it("allows the bus-less scout on the memory default", async () => {
    const mod = await loadConfig({ ROLE: "scout", BUS: "memory" });
    expect(() => mod.assertConfigForRole()).not.toThrow();
  });

  it("accepts ROLE=all on memory with a key", async () => {
    const mod = await loadConfig({ ARENA_API_KEY: "k" });
    expect(() => mod.assertConfigForRole()).not.toThrow();
  });
});
