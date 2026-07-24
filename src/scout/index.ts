/**
 * ROLE=scout — a passive observer that never fights. It rides the arena's
 * public spectator WebSocket (no API key, no account, no LLM cost) and turns
 * the fog-free 10 Hz stream into behavioural opponent profiles: draft
 * tendencies, win rates, K/D, aggression, preferred fighting range, dodge and
 * mine habits, zone discipline. Profiles persist to scout.json, travel with
 * the repo via the knowledge dump, and feed the fighting fleet's Loadout/
 * Strategist prompts — so the fleet knows an opponent's playstyle BEFORE the
 * first time it ever faces them. Runs fine 24/7, with or without the fleet.
 */

import { getSpectatorFeed } from "../arena/spectator";
import { dumpKnowledge, startKnowledgeAutoPush } from "../shared/knowledge";
import { child } from "../shared/logger";
import { ScoutAggregator } from "./aggregator";
import { loadMergedScoutSnapshot, saveScoutSnapshot, scoutFilePath } from "./store";

const log = child("scout");

const SAVE_EVERY_MS = 15_000;

export interface ScoutHandle {
  stop(): Promise<void>;
}

export async function startScout(): Promise<ScoutHandle> {
  const feed = getSpectatorFeed();
  if (!feed) {
    throw new Error("ROLE=scout needs the spectator feed — unset ARENA_SPECTATOR=false");
  }

  // Merges the live logs/brain/scout.json with the repo-committed
  // data/knowledge/brain/scout.json (additive per-bot counters — see
  // mergeScoutProfiles) instead of picking one and discarding the other, so
  // an independent scout run never has to start blind or lose whatever it
  // uniquely observed the moment it dumps+pushes.
  const prior = loadMergedScoutSnapshot();
  const priorRounds = prior?.roundsObserved ?? 0;
  const agg = new ScoutAggregator(prior?.profiles ?? []);
  log.info(
    { file: scoutFilePath(), knownOpponents: prior?.profiles.length ?? 0, priorRounds },
    "scout online — watching the arena",
  );

  let lastFinalized = 0;
  const persist = (): void => {
    saveScoutSnapshot({
      v: 1,
      savedAt: Date.now(),
      roundsObserved: priorRounds + agg.finalizedRounds,
      profiles: agg.snapshot(),
    });
  };

  const unsub = feed.onFrame((frame) => agg.ingest(frame));
  const timer = setInterval(() => {
    persist();
    if (agg.finalizedRounds > lastFinalized) {
      lastFinalized = agg.finalizedRounds;
      const top = agg.summarize(5);
      log.info(
        {
          roundsThisSession: agg.finalizedRounds,
          opponents: agg.snapshot().length,
          top: top.map((t) => `${t.name}(${t.primaryWeapon ?? "?"}) win ${Math.round(t.winRate * 100)}% agg ${t.aggression}`),
        },
        "scout profiles updated",
      );
    }
  }, SAVE_EVERY_MS);
  // Deliberately NOT unref'd: in a ROLE=scout process this interval (plus the
  // WS) IS the program — an unref'd timer let the process exit silently the
  // moment the socket had nothing pending (observed live: scout died 9 min
  // in, no error, mid-reconnect gap). Shutdown goes through SIGINT/SIGTERM.

  // Scheduled commit+push of the knowledge dump (no bus in a scout process —
  // file copies only). Deliberately not in stop(): git belongs to a healthy
  // process, not a dying one.
  const autoPush = startKnowledgeAutoPush(null, []);

  return {
    async stop() {
      unsub();
      clearInterval(timer);
      autoPush.stop();
      // Keep the in-progress round: partial evidence beats losing it.
      agg.finalizeRound();
      persist();
      // Mirror scout.json into the repo dump; the scheduled auto-push (or a
      // human) commits it from a live process.
      try {
        await dumpKnowledge(null, []);
      } catch (e) {
        log.warn({ err: (e as Error).message }, "scout knowledge dump failed — profiles stay in logs/");
      }
      log.info({ rounds: agg.finalizedRounds }, "scout stopped — profiles persisted");
    },
  };
}
