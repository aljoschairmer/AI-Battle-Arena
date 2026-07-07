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
import { mergeScoutProfiles, type ScoutProfile } from "./aggregator";
import { child } from "../shared/logger";
import { knowledgePaths } from "../shared/knowledge";

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

/**
 * The repo-committed snapshot (data/knowledge/brain/scout.json). Distinct
 * from scoutFilePath() — that one is the LIVE working file this process
 * reads/writes every save tick; this one is whatever's checked out from git.
 * Independent scout runs (different machines/containers/sessions, each with
 * their own logs/brain/) commit their own dumps to the same shared file, so
 * the two can and do diverge — see loadRicherScoutSnapshot below.
 */
export function scoutRepoSnapshotPath(): string {
  return join(knowledgePaths().dir, "brain", "scout.json");
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

/**
 * Merge the live logs/brain/scout.json with the repo-committed
 * data/knowledge/brain/scout.json into one snapshot, and use it as the boot
 * seed — instead of picking one and discarding whatever the other uniquely
 * observed. Safe because ScoutProfile's counters are purely additive (see
 * mergeScoutProfiles' doc for the double-count corner case and why it's an
 * acceptable trade — derived ratios barely move even under full overlap).
 *
 * Why this matters at all: `git pull` alone doesn't get the committed
 * knowledge into a running scout, since logs/brain/ is gitignored and never
 * touched by a pull — only the data/knowledge/ copy is. Merging both at
 * boot means an independent scout run (different machine/container/session)
 * never has to choose between "start blind" and "manually copy files
 * around" to pick up what every other scout has already learned.
 */
export function loadMergedScoutSnapshot(): ScoutSnapshot | null {
  const live = loadScoutSnapshot();
  const repo = loadScoutSnapshot(scoutRepoSnapshotPath());
  if (!repo) return live;
  if (!live) return repo;
  if (live.roundsObserved === repo.roundsObserved) return live; // already in sync — nothing to merge
  log.info(
    { liveRounds: live.roundsObserved, repoRounds: repo.roundsObserved },
    "merging local and repo-committed scout knowledge at boot " +
      "(run `git pull` before starting the scout to fold in the latest shared knowledge first)",
  );
  return {
    v: 1,
    savedAt: Math.max(live.savedAt, repo.savedAt),
    roundsObserved: live.roundsObserved + repo.roundsObserved,
    profiles: mergeScoutProfiles(live.profiles, repo.profiles),
  };
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
