import type { StatBlock, Weapon } from "../types/protocol";
import { BUILD_FLOORS, optimizeBuild } from "../shared/derived";

/**
 * Static weapon knowledge used by the reactive controller. Authoritative ranges
 * come from the server (`loadout_confirmed.computed.attack_range` and each
 * enemy's `attack_range`); these are sensible fallbacks and behavioural hints
 * the server doesn't spell out.
 */
export interface WeaponProfile {
  weapon: Weapon;
  ranged: boolean;
  /** Fallback attack range in tiles if the server hasn't told us. */
  baseRange: number;
  /**
   * Ideal distance to fight from. Melee wants to be adjacent; ranged wants to
   * sit near max range and kite. Used to compute approach/retreat.
   */
  preferredRange: number;
  usesCharge: boolean; // bow
  aoe: boolean; // staff burn fields
  backstab: boolean; // daggers reward hitting rear_exposed targets
  brace: boolean; // spear can brace against chargers
  /** Score for loadout selection heuristics (higher = generally stronger pick). */
  metaScore: number;
  /** Base per-hit damage (from the arena weapon table). */
  damage: number;
  /** Attack cooldown in seconds (from the arena weapon table). */
  cooldown: number;
  /** Damage-per-second = damage / cooldown; drives the trade evaluator + threat map. */
  estDps: number;
}

// Numbers from the live arena weapon table (damage / range / cooldown). DPS is
// damage/cooldown. Note: the grapple WEAPON has range 5 (its Slam); the 12-tile
// grapple is the universal ability every bot gets.
export const WEAPONS: Record<Weapon, WeaponProfile> = {
  sword: { weapon: "sword", ranged: false, baseRange: 1, preferredRange: 1, usesCharge: false, aoe: false, backstab: false, brace: false, metaScore: 0.86, damage: 21, cooldown: 0.55, estDps: 38 },
  daggers: { weapon: "daggers", ranged: false, baseRange: 1, preferredRange: 1, usesCharge: false, aoe: false, backstab: true, brace: false, metaScore: 0.88, damage: 11, cooldown: 0.35, estDps: 31 },
  shield: { weapon: "shield", ranged: false, baseRange: 1, preferredRange: 1, usesCharge: false, aoe: false, backstab: false, brace: false, metaScore: 0.72, damage: 14, cooldown: 0.8, estDps: 17.5 },
  spear: { weapon: "spear", ranged: false, baseRange: 2, preferredRange: 2, usesCharge: false, aoe: false, backstab: false, brace: true, metaScore: 0.76, damage: 17, cooldown: 0.75, estDps: 22.7 },
  bow: { weapon: "bow", ranged: true, baseRange: 8, preferredRange: 7, usesCharge: true, aoe: false, backstab: false, brace: false, metaScore: 0.82, damage: 16, cooldown: 1.05, estDps: 15.2 },
  staff: { weapon: "staff", ranged: true, baseRange: 6, preferredRange: 5, usesCharge: false, aoe: true, backstab: false, brace: false, metaScore: 0.7, damage: 17, cooldown: 1.65, estDps: 10.3 },
  grapple: { weapon: "grapple", ranged: true, baseRange: 5, preferredRange: 4, usesCharge: false, aoe: false, backstab: false, brace: false, metaScore: 0.64, damage: 14, cooldown: 1.05, estDps: 13.3 },
};

export function profileFor(weapon: Weapon): WeaponProfile {
  return WEAPONS[weapon] ?? WEAPONS.sword;
}

/**
 * Fight-power-optimal default stat spread per weapon (budget 20, 1..10 each),
 * derived from the arena's Stat Simulator formulas (see shared/derived.ts).
 * Because effective_hp already fully credits defense (and defense only buys
 * 3%/pt, capped at 30%), the optimum splits the budget ~evenly between HP and
 * attack over a per-weapon mobility floor and keeps defense low — noticeably
 * more aggressive than a flat 5/5/5/5, which is what we want. Computed once so
 * the values stay consistent with the math and can't silently drift.
 */
export const DEFAULT_STATS: Record<Weapon, StatBlock> = Object.fromEntries(
  (Object.keys(WEAPONS) as Weapon[]).map((w) => {
    const p = WEAPONS[w];
    const f = BUILD_FLOORS[w];
    return [w, optimizeBuild(p.damage, p.cooldown, { speedFloor: f.speedFloor, defenseFloor: f.defenseFloor })];
  }),
) as Record<Weapon, StatBlock>;
