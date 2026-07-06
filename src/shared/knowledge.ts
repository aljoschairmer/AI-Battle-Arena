/**
 * src/shared/knowledge.ts
 *
 * Repo-persisted knowledge dump & restore. Everything the bot LEARNS lives in
 * two places at runtime:
 *   1. the bus KV mirror (arena:kv:policy / arena:kv:insights per bot scope) —
 *      the Tuner's learned behaviour knobs and the Analyst's distilled
 *      insights, but with a ~300s TTL and gone entirely when Redis restarts,
 *   2. the brain memory files (BRAIN_MEMORY_DIR/memory*.json) — round
 *      history, opponent profiles, insights — durable, but outside the repo
 *      (logs/ is gitignored).
 *
 * `npm run knowledge:dump` snapshots both into KNOWLEDGE_DIR (default
 * data/knowledge/, committed to the repo). On process start,
 * restoreKnowledge() replays the dump the CONSERVATIVE way:
 *   - a KV key is seeded only when the bus doesn't currently hold one
 *     (a live Tuner's fresher policy is never clobbered), and the existing
 *     version/ts freshness checks + sanitizePolicy still apply downstream,
 *   - a memory file is copied only when the target doesn't exist yet
 *     (local learning always beats the committed seed).
 * So a fresh clone starts with everything the fleet ever learned, while a
 * long-running deployment is unaffected. Disable with KNOWLEDGE_RESTORE=0.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Bus } from "../bus";
import { Keys } from "../bus";
import { child } from "./logger";

const log = child("knowledge");

/** The KV keys that hold LEARNED state (directives are round-scoped noise). */
const LEARNED_KEYS = [Keys.currentPolicy, Keys.learningInsights];

export interface KnowledgePaths {
  /** Dump location inside the repo (committed). */
  dir: string;
  /** Live brain memory dir (matches BrainMemoryStore's default). */
  brainDir: string;
}

export function knowledgePaths(): KnowledgePaths {
  return {
    dir: process.env.KNOWLEDGE_DIR ?? "data/knowledge",
    brainDir: process.env.BRAIN_MEMORY_DIR ?? "logs/brain",
  };
}

/** Full KV key for a bot scope ("" = unscoped/global). */
function scopedKey(scope: string, key: string): string {
  return scope ? `${scope}${key}` : key;
}

/**
 * Snapshot the learned KV entries (per scope) and every brain memory file
 * into the dump dir. Best-effort: an unreachable bus just yields fewer keys.
 * Returns a summary for logging/tests.
 */
export async function dumpKnowledge(
  bus: Bus,
  scopes: string[],
  paths: KnowledgePaths = knowledgePaths(),
): Promise<{ kvKeys: string[]; kvLive: string[]; memoryFiles: string[] }> {
  mkdirSync(join(paths.dir, "brain"), { recursive: true });

  // 1. Learned KV entries across every bot scope — MERGED over the existing
  // dump, never replacing it wholesale. The KV mirror carries a ~300s TTL
  // and is only rewritten when the Brain actually publishes; during an LLM
  // provider outage the entries expire and a naive dump would clobber the
  // committed seed with {} — measured live: an afternoon-long 402/429 storm
  // silently emptied kv.json and the learned Tuner policies survived only in
  // git history. A key is overwritten only when a live value exists; absent
  // keys keep their last known value (stale learning beats no learning; the
  // restore side is missing-only anyway, so a fresher live system ignores it).
  const kvPath = join(paths.dir, "kv.json");
  let kv: Record<string, unknown> = {};
  try {
    kv = JSON.parse(readFileSync(kvPath, "utf8")) as Record<string, unknown>;
  } catch {
    /* no previous dump / unreadable — start fresh */
  }
  const kvLive: string[] = [];
  for (const scope of scopes) {
    for (const key of LEARNED_KEYS) {
      const full = scopedKey(scope, key);
      try {
        const value = await bus.getKV<unknown>(full);
        if (value !== null) {
          kv[full] = value;
          kvLive.push(full);
        }
      } catch {
        /* bus unreachable — keep the previous dump's entries */
      }
    }
  }
  writeFileSync(kvPath, JSON.stringify(kv, null, 2));

  // 2. Brain memory files (round history, opponent profiles, insights) plus
  // the Scout's watched-opponent profiles (scout.json — separate file so its
  // observed rounds never leak into our own weapon-evidence statistics).
  const memoryFiles: string[] = [];
  try {
    for (const f of readdirSync(paths.brainDir)) {
      if (!/^(memory.*|scout)\.json$/.test(f)) continue;
      copyFileSync(join(paths.brainDir, f), join(paths.dir, "brain", f));
      memoryFiles.push(f);
    }
  } catch {
    /* no brain dir yet — nothing learned on disk */
  }

  return { kvKeys: Object.keys(kv), kvLive, memoryFiles };
}

/**
 * Replay a committed dump into the live system — missing-only, never
 * overwriting. Called once at process start (before engines/brains spin up,
 * so the brain's KV seed read and BrainMemoryStore.load() find the data).
 */
export async function restoreKnowledge(
  bus: Bus,
  paths: KnowledgePaths = knowledgePaths(),
): Promise<{ kvSeeded: string[]; memorySeeded: string[] }> {
  const kvSeeded: string[] = [];
  const memorySeeded: string[] = [];
  const flag = (process.env.KNOWLEDGE_RESTORE ?? "true").toLowerCase();
  if (flag === "0" || flag === "false") return { kvSeeded, memorySeeded };

  // 1. KV entries — only where the bus holds nothing right now.
  const kvPath = join(paths.dir, "kv.json");
  if (existsSync(kvPath)) {
    let kv: Record<string, unknown> = {};
    try {
      kv = JSON.parse(readFileSync(kvPath, "utf8")) as Record<string, unknown>;
    } catch (e) {
      log.warn({ err: (e as Error).message, kvPath }, "knowledge kv.json unreadable — skipping KV restore");
    }
    for (const [key, value] of Object.entries(kv)) {
      try {
        if ((await bus.getKV<unknown>(key)) !== null) continue; // live state wins
        await bus.setKV(key, value);
        kvSeeded.push(key);
      } catch {
        /* bus unreachable — the KV mirror is an optimisation, not a dependency */
      }
    }
  }

  // 2. Brain memory files — only where none exists locally yet.
  const dumpBrain = join(paths.dir, "brain");
  if (existsSync(dumpBrain)) {
    try {
      mkdirSync(paths.brainDir, { recursive: true });
      for (const f of readdirSync(dumpBrain)) {
        if (!/^(memory.*|scout)\.json$/.test(f)) continue;
        const target = join(paths.brainDir, f);
        if (existsSync(target)) continue; // local learning wins
        copyFileSync(join(dumpBrain, f), target);
        memorySeeded.push(f);
      }
    } catch (e) {
      log.warn({ err: (e as Error).message }, "knowledge memory restore failed — continuing without seed");
    }
  }

  if (kvSeeded.length || memorySeeded.length) {
    log.info({ kvSeeded, memorySeeded }, "knowledge restored from repo dump");
  }
  return { kvSeeded, memorySeeded };
}
