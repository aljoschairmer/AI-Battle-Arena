import type { Weapon } from "../types/protocol";
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
 */
export function enforceWeaponEvidence(
  pick: Weapon,
  fleetIndex: number | null,
  fleetSize: number,
  rates: WeaponWinRates,
): Weapon | null {
  if (fleetSize <= 1 || fleetIndex === null) return null;
  const pickRate = rateOf(rates, pick);
  if (pickRate === null || pickRate >= BAN_RATE) return null; // unproven or fine

  const allowed = SLOT_WEAPONS[fleetIndex] ?? (Object.keys(rates) as Weapon[]);
  const bestIn = (set: Weapon[]): Weapon | null => {
    let best: Weapon | null = null;
    let bestRate = PROMOTE_RATE;
    for (const w of set) {
      if (w === pick) continue;
      const r = rateOf(rates, w);
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
  return bestIn(allowed) ?? bestIn(Object.keys(rates) as Weapon[]);
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
