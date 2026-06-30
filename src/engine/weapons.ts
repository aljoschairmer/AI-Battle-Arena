import type { Weapon } from "../types/protocol";

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
}

export const WEAPONS: Record<Weapon, WeaponProfile> = {
  sword: { weapon: "sword", ranged: false, baseRange: 1, preferredRange: 1, usesCharge: false, aoe: false, backstab: false, brace: false, metaScore: 0.78 },
  daggers: { weapon: "daggers", ranged: false, baseRange: 1, preferredRange: 1, usesCharge: false, aoe: false, backstab: true, brace: false, metaScore: 0.74 },
  shield: { weapon: "shield", ranged: false, baseRange: 1, preferredRange: 1, usesCharge: false, aoe: false, backstab: false, brace: false, metaScore: 0.7 },
  spear: { weapon: "spear", ranged: false, baseRange: 2, preferredRange: 2, usesCharge: false, aoe: false, backstab: false, brace: true, metaScore: 0.72 },
  bow: { weapon: "bow", ranged: true, baseRange: 7, preferredRange: 6, usesCharge: true, aoe: false, backstab: false, brace: false, metaScore: 0.82 },
  staff: { weapon: "staff", ranged: true, baseRange: 5, preferredRange: 5, usesCharge: false, aoe: true, backstab: false, brace: false, metaScore: 0.76 },
  grapple: { weapon: "grapple", ranged: true, baseRange: 12, preferredRange: 8, usesCharge: false, aoe: false, backstab: false, brace: false, metaScore: 0.65 },
};

export function profileFor(weapon: Weapon): WeaponProfile {
  return WEAPONS[weapon] ?? WEAPONS.sword;
}

/** A balanced default stat spread per weapon (sums to the 20 budget, 1..10 each). */
export const DEFAULT_STATS: Record<Weapon, { hp: number; speed: number; attack: number; defense: number }> = {
  sword: { hp: 6, speed: 5, attack: 6, defense: 3 },
  daggers: { hp: 4, speed: 8, attack: 6, defense: 2 },
  shield: { hp: 8, speed: 4, attack: 3, defense: 5 },
  spear: { hp: 6, speed: 5, attack: 6, defense: 3 },
  bow: { hp: 5, speed: 6, attack: 7, defense: 2 },
  staff: { hp: 5, speed: 5, attack: 7, defense: 3 },
  grapple: { hp: 6, speed: 6, attack: 5, defense: 3 },
};
