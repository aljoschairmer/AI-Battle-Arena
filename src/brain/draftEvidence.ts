import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Weapon } from "../types/protocol";
import type { OutcomeEntry } from "../engine/outcomeLog";
import { BrainMemoryStore } from "../shared/memoryStore";

/**
 * Deterministic evidence enforcement for the fleet draft. The Loadout LLM
 * receives the fleet-wide weapon history and an explicit authority rule, but
 * live drafts showed the (free-tier) model ignoring it — it kept picking a
 * ~2%-win-rate weapon over a 20-28% one with 100+ rounds of evidence. Prompts
 * are advisory; this is not: if the model's pick is a proven loser and a
 * proven winner is allowed for the slot, the pick is overridden.
 *
 * Thresholds are deliberately conservative: both the ban and the promotion
 * need >= MIN_PLAYED rounds of history, so a lone lucky/unlucky round can't
 * flip drafts. Solo bots are never overridden (fleetSize <= 1 -> null).
 */

const MIN_PLAYED = 10;
const BAN_RATE = 0.1;
const PROMOTE_RATE = 0.15;

/** Archetype sets mirroring the loadout prompt's fleet rule. */
const SLOT_WEAPONS: Record<number, Weapon[]> = {
  1: ["bow", "staff", "grapple"],
  2: ["sword", "shield", "spear"],
};

export type WeaponWinRates = Partial<Record<Weapon, { wins: number; played: number }>>;

function rateOf(rates: WeaponWinRates, w: Weapon): number | null {
  const e = rates[w];
  if (!e || e.played < MIN_PLAYED) return null;
  return e.wins / e.played;
}

/**
 * Returns the weapon the slot SHOULD play instead, or null when the LLM's
 * pick stands (no strong evidence against it, or no proven alternative the
 * slot may use).
 *
 * `rates` (recency window, ~200 rounds/bot) and `allTimeRates` (unbounded
 * outcome log, see allTimeWeaponWinRatesFromDisk) are used ASYMMETRICALLY:
 *   - Whether the CURRENT pick gets BANNED is judged on `rates` first: the
 *     recency window exists so the fleet reacts when the live meta turns
 *     against a weapon RIGHT NOW — an old, rosy all-time average must never
 *     shield a pick that's actually underwater this week. But when `rates`
 *     is SILENT on the pick (< MIN_PLAYED recent rounds), the all-time
 *     record decides instead of defaulting to innocent. Measured live: a
 *     reconnect re-drafted daggers (5.5%/384 all-time) precisely BECAUSE it
 *     had aged out of everyone's recency window — "no recent evidence" was
 *     read as "unproven" when the unbounded log had 384 rounds of proof,
 *     and the bot then had to re-lose ~49 rounds to re-learn it.
 *   - Candidate ALTERNATIVES (in bestIn) are judged on whichever of the two
 *     sources is more favourable. A weapon can be promoted either because
 *     it's hot right now (recent) or because it has a long, proven track
 *     record even though it hasn't been drafted in a while — recent has
 *     nothing meaningful to say about a weapon nobody's played lately, so
 *     the all-time number stands on its own. This is the fix for a measured
 *     live gap: bow's 19.2%/567-round all-time record (independently
 *     confirmed as the arena's best by the spectator scout's cross-bot
 *     observation) had aged down to a 20-round/10% sliver in the recency
 *     window and could no longer be promoted back on its own.
 */
export function enforceWeaponEvidence(
  pick: Weapon,
  fleetIndex: number | null,
  fleetSize: number,
  rates: WeaponWinRates,
  allTimeRates: WeaponWinRates = {},
): Weapon | null {
  // Solo bots (fleetSize <= 1 / no fleetIndex) get the SAME evidence gate,
  // just without a slot archetype (any weapon may be promoted). They were
  // originally exempt ("don't second-guess a lone experiment"), which
  // backfired the first time a lone bot was run to WIN: with the LLM race
  // lost at boot, the deterministic fallback drafted daggers (5.5%/384
  // all-time) and nothing was allowed to stop it.
  // Recent form wins when it exists; the all-time record only speaks when
  // the recency window has nothing to say about the pick (see doc above).
  const pickRate = rateOf(rates, pick) ?? rateOf(allTimeRates, pick);
  if (pickRate === null || pickRate >= BAN_RATE) return null; // unproven or fine

  const allWeapons = [...new Set([...Object.keys(rates), ...Object.keys(allTimeRates)])] as Weapon[];
  const allowed = (fleetIndex !== null ? SLOT_WEAPONS[fleetIndex] : undefined) ?? allWeapons;
  const candidateRate = (w: Weapon): number | null => {
    const recent = rateOf(rates, w);
    const allTime = rateOf(allTimeRates, w);
    if (recent === null) return allTime;
    if (allTime === null) return recent;
    return Math.max(recent, allTime);
  };
  const bestIn = (set: Weapon[]): Weapon | null => {
    let best: Weapon | null = null;
    let bestRate = PROMOTE_RATE;
    for (const w of set) {
      if (w === pick) continue;
      const r = candidateRate(w);
      if (r !== null && r >= bestRate) {
        bestRate = r;
        best = w;
      }
    }
    return best;
  };
  // Prefer a proven winner inside the slot's archetype; when the WHOLE
  // archetype is losing/unproven, fall back to the global proven best —
  // measured live: the frontline slot sat on a 7% spear for 29 rounds
  // because sword (2%) and shield (unproven) were its only in-set options
  // while bow ran 20%+ in the same fleet. A banned pick beats archetype
  // purity only until the evidence is overwhelming.
  return bestIn(allowed) ?? bestIn(allWeapons);
}

/**
 * Merge per-weapon win/played evidence across every fleet member's on-disk
 * memory (see BrainMemoryStore.loadFleet for why fleet-wide, not per-bot).
 * Shared by the Brain's orchestrator AND the Engine's fallback draft: with
 * slow (free-tier) models the Brain regularly loses the race against the
 * engine's 8s selection deadline, so the deterministic fallback is the
 * ACTUAL draft — it needs the same evidence check or it happily re-drafts
 * the fleet's proven-loser weapon every time the LLM is late. Boot/draft
 * time only, best-effort ({} on any read failure).
 */
export function fleetWeaponWinRatesFromDisk(
  store: BrainMemoryStore = new BrainMemoryStore(),
): WeaponWinRates {
  const merged: WeaponWinRates = {};
  for (const snap of store.loadFleet()) {
    for (const r of snap.rounds) {
      if (!r.ourWeapon) continue;
      const e = merged[r.ourWeapon] ?? { wins: 0, played: 0 };
      e.played += 1;
      if (r.won) e.wins += 1;
      merged[r.ourWeapon] = e;
    }
  }
  return merged;
}

/**
 * All-time per-weapon win/played tally read from the persistent, UNBOUNDED
 * outcome log (logs/outcomes/outcomes.jsonl — OutcomeLog in engine/, one line
 * per completed round, never pruned). Backstops fleetWeaponWinRatesFromDisk's
 * per-bot RoundHistory(200) ring buffer, which forgets: a weapon that stops
 * being drafted for a while ages out of that 200-round window entirely and
 * becomes invisible to enforceWeaponEvidence's promotion logic even when it
 * was a proven long-run winner. Measured live: bow sat at 19.2%/567 rounds
 * all-time (and independently confirmed as the arena's best by the spectator
 * scout's cross-bot observation, ~8.5% vs. every other weapon) yet had aged
 * down to a 20-round/10% sliver in the rolling window — too thin to ever be
 * promoted back on its own.
 *
 * Best-effort like its sibling: a missing/unreadable file (fresh checkout, a
 * split ROLE=engine/ROLE=brain deployment without a shared volume for
 * logs/outcomes) returns {} and callers fall back to recency-only, exactly
 * the behaviour before this existed. A corrupt/partial JSON line (the log can
 * be read mid-append) is skipped, not fatal to the rest of the file.
 */
export function allTimeWeaponWinRatesFromDisk(path?: string): WeaponWinRates {
  const filePath = path ?? join(process.env.OUTCOME_LOG_DIR ?? "logs/outcomes", "outcomes.jsonl");
  const merged: WeaponWinRates = {};
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return merged;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: Partial<OutcomeEntry>;
    try {
      entry = JSON.parse(line) as Partial<OutcomeEntry>;
    } catch {
      continue;
    }
    const w = entry.ourWeapon;
    if (!w) continue;
    const e = merged[w] ?? { wins: 0, played: 0 };
    e.played += 1;
    if (entry.won) e.wins += 1;
    merged[w] = e;
  }
  return merged;
}
