import type { FallbackBehavior, LoadoutSelection, Weapon } from "../types/protocol";
import { normalizeStats } from "../shared/stats";
import { DEFAULT_STATS, WEAPONS } from "./weapons";

/**
 * Server-side autonomous behaviour best matched to each weapon's playstyle, used
 * when the bot misses a tick. All values are from the arena's accepted set
 * (aggressive | defensive | opportunistic | territorial | hunter).
 */
const WEAPON_FALLBACK: Record<Weapon, FallbackBehavior> = {
  sword: "aggressive",
  daggers: "hunter", // chase and finish
  shield: "defensive",
  spear: "territorial", // hold ground / brace
  bow: "territorial", // keep range, hold a line
  staff: "opportunistic", // poke clusters, play the field
  grapple: "aggressive",
};

/**
 * Deterministic loadout chooser used as the Brain-independent fallback. Picks a
 * strong default weapon, nudged by the round modifier, and a legal stat spread.
 * The Engine always has this ready so it can select a loadout inside the 10s
 * window even if the LLM is slow or absent.
 */
export function chooseFallbackLoadout(opts: {
  availableWeapons?: Weapon[];
  modifier?: string;
  budget?: number;
  min?: number;
  max?: number;
}): LoadoutSelection {
  const available = opts.availableWeapons?.length
    ? opts.availableWeapons
    : (Object.keys(WEAPONS) as Weapon[]);

  const mod = (opts.modifier ?? "").toLowerCase();

  const weapon = available
    .map((w) => ({ w, score: WEAPONS[w].metaScore + modifierBonus(w, mod) }))
    .sort((a, b) => b.score - a.score)[0]!.w;

  const base = DEFAULT_STATS[weapon] ?? { hp: 6, speed: 5, attack: 6, defense: 3 };
  const stats = normalizeStats(base, opts.budget ?? 20, opts.min ?? 1, opts.max ?? 10);

  return {
    weapon,
    stats,
    fallback_behavior: WEAPON_FALLBACK[weapon] ?? "defensive",
  };
}

/** Small per-modifier weapon preference tweaks. */
function modifierBonus(weapon: Weapon, modifier: string): number {
  if (!modifier) return 0;
  const p = WEAPONS[weapon];
  // Hazard storm / fast zone reward mobility + range (stay out of trouble).
  if (modifier.includes("hazard") || modifier.includes("fast")) {
    return p.ranged ? 0.08 : -0.03;
  }
  // Pickup surge rewards mobility to grab loot.
  if (modifier.includes("pickup")) {
    return weapon === "daggers" ? 0.06 : 0;
  }
  // Double bounty rewards burst kill potential.
  if (modifier.includes("bounty")) {
    return p.backstab || p.usesCharge ? 0.05 : 0;
  }
  return 0;
}
