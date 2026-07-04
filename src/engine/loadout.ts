import type { FallbackBehavior, LoadoutSelection, Weapon } from "../types/protocol";
import { normalizeStats } from "../shared/stats";
import { BUILD_FLOORS, optimizeBuild } from "../shared/derived";
import { rankCounterPicks } from "./matchups";
import { WEAPONS } from "./weapons";

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
  /** Weapon counts seen in the pre-round lobby — drives the counter-pick. */
  lobbyWeapons?: Partial<Record<Weapon, number>>;
  /**
   * Position in our own fleet (0-based). N bots ranking identical inputs pick
   * identical weapons (observed live: the whole fleet opening daggers every
   * round); rotating each bot onto a different top-3 pick keeps the
   * deterministic fallback fleet complementary. Omit for a lone bot.
   */
  fleetIndex?: number;
}): LoadoutSelection {
  const available = opts.availableWeapons?.length
    ? opts.availableWeapons
    : (Object.keys(WEAPONS) as Weapon[]);

  const mod = (opts.modifier ?? "").toLowerCase();

  // Rank by standalone strength (metaScore + modifier fit) blended with the
  // matchup edge against whatever weapons the lobby is fielding (Strategy-tab
  // matrix). With no lobby intel the counter term is 0 and this is pure meta.
  const ranked = rankCounterPicks(
    available,
    opts.lobbyWeapons ?? {},
    (w) => WEAPONS[w].metaScore + modifierBonus(w, mod),
  );
  const slot = opts.fleetIndex !== undefined ? opts.fleetIndex % Math.min(3, ranked.length) : 0;
  const weapon = ranked[slot]!.weapon;

  // Fight-power-optimal spread for the ACTUAL round budget/bounds (the arena can
  // vary them per round), honouring the weapon's mobility/durability floors.
  const p = WEAPONS[weapon];
  const floors = BUILD_FLOORS[weapon];
  const optimal = optimizeBuild(p.damage, p.cooldown, {
    budget: opts.budget ?? 20,
    min: opts.min ?? 1,
    max: opts.max ?? 10,
    speedFloor: floors.speedFloor,
    defenseFloor: floors.defenseFloor,
  });
  // normalizeStats is a no-op safety net (optimizeBuild already returns a legal,
  // budget-exact spread) but guarantees the invariant even if bounds are exotic.
  const stats = normalizeStats(optimal, opts.budget ?? 20, opts.min ?? 1, opts.max ?? 10);

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
