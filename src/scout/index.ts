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
import { child } from "../shared/logger";
import { ScoutAggregator } from "./aggregator";
import { loadScoutSnapshot, saveScoutSnapshot, scoutFilePath } from "./store";

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

  const prior = loadScoutSnapshot();
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

  return {
    async stop() {
      unsub();
      clearInterval(timer);
      // Keep the in-progress round: partial evidence beats losing it.
      agg.finalizeRound();
      persist();
      log.info({ rounds: agg.finalizedRounds }, "scout stopped — profiles persisted");
    },
  };
}
