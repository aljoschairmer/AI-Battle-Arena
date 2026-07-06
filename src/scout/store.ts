/**
 * Disk persistence for the Scout's opponent profiles. Deliberately its own
 * file (scout.json) rather than a memory-*.json sibling: BrainMemoryStore's
 * loadFleet() merges memory*.json ROUND histories into the fleet's weapon
 * evidence, and scouted rounds are other bots' rounds — they must never leak
 * into our own draft statistics. The Brain reads this file read-only for its
 * prompts; the knowledge dump carries it into the repo like everything else.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ScoutProfile } from "./aggregator";
import { child } from "../shared/logger";

const log = child("scout:store");

export interface ScoutSnapshot {
  v: 1;
  savedAt: number;
  /** Arena rounds folded in across all scout sessions. */
  roundsObserved: number;
  profiles: ScoutProfile[];
}

export function scoutFilePath(): string {
  return join(process.env.BRAIN_MEMORY_DIR ?? "logs/brain", "scout.json");
}

/** Null when absent/corrupt — the scout just starts fresh. */
export function loadScoutSnapshot(path = scoutFilePath()): ScoutSnapshot | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as ScoutSnapshot;
    if (raw?.v !== 1 || !Array.isArray(raw.profiles)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Atomic write (tmp + rename), best-effort — a disk hiccup never kills the scout. */
export function saveScoutSnapshot(snap: ScoutSnapshot, path = scoutFilePath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify(snap));
    renameSync(`${path}.tmp`, path);
  } catch (e) {
    log.warn({ err: (e as Error).message, path }, "scout snapshot persist failed — profiles stay in memory");
  }
}
