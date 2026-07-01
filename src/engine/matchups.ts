import type { Weapon } from "../types/protocol";

/**
 * Weapon matchup knowledge scraped from the arena's public Strategy tab
 * (/dashboard → Strategy) and its canonical /api/v1/bot-setup spec.
 *
 * WEAPON_MATCHUPS[attacker][defender] = rating in [-2, +2]:
 *   +2 hard advantage · +1 slight edge · 0 even · -1 slight disadvantage · -2 hard counter.
 * The site only rates the six "combat" weapons (grapple is a universal ability
 * and a niche loadout, so it has no row/column — treated as even, 0).
 */
export const WEAPON_MATCHUPS: Partial<Record<Weapon, Partial<Record<Weapon, number>>>> = {
  sword: { sword: 0, bow: -1, daggers: 1, shield: 1, spear: 0, staff: -1 },
  bow: { sword: 1, bow: 0, daggers: -2, shield: 1, spear: 1, staff: 0 },
  daggers: { sword: -1, bow: 2, daggers: 0, shield: -1, spear: -1, staff: 2 },
  shield: { sword: -1, bow: -1, daggers: 1, shield: 0, spear: -1, staff: -2 },
  spear: { sword: 0, bow: -1, daggers: 1, shield: 1, spear: 0, staff: -1 },
  staff: { sword: 1, bow: 0, daggers: -2, shield: 2, spear: 1, staff: 0 },
};

/** Per-weapon role + counter guidance (from the Strategy tab's WEAPON_META). */
export interface WeaponRoleMeta {
  role: string;
  strongVs: string;
  counter: string;
  /** The site's suggested starter split (we usually run a more aggressive one). */
  starterBuild: string;
}

export const WEAPON_ROLE_META: Record<Weapon, WeaponRoleMeta> = {
  sword: { role: "Balanced frontline weapon.", strongVs: "Daggers, shield", counter: "Bow, staff", starterBuild: "hp:5 speed:5 attack:5 defense:5" },
  bow: { role: "Long-range poke and charge management.", strongVs: "Shield, spear", counter: "Daggers, grapple", starterBuild: "hp:4 speed:6 attack:6 defense:4" },
  daggers: { role: "Close-range burst assassin.", strongVs: "Bow, staff", counter: "Sword, spear", starterBuild: "hp:4 speed:6 attack:6 defense:4" },
  shield: { role: "Slow attrition tank.", strongVs: "Daggers", counter: "Staff, bow", starterBuild: "hp:7 speed:3 attack:4 defense:6" },
  spear: { role: "Spacing and brace control.", strongVs: "Daggers, shield", counter: "Bow, staff", starterBuild: "hp:5 speed:5 attack:6 defense:4" },
  staff: { role: "Delayed AoE zone denial.", strongVs: "Shield, sword", counter: "Daggers, bow", starterBuild: "hp:4 speed:5 attack:7 defense:4" },
  grapple: { role: "Wall-slam bruiser.", strongVs: "Cornered ranged bots", counter: "Bow, staff", starterBuild: "hp:5 speed:5 attack:6 defense:4" },
};

/** Rating of `attacker` vs `defender` (0 when either isn't in the rated set). */
export function matchupRating(attacker: Weapon, defender: Weapon): number {
  return WEAPON_MATCHUPS[attacker]?.[defender] ?? 0;
}

/**
 * Expected matchup value of picking `weapon` into a lobby whose weapon counts
 * are `lobbyWeapons` — the count-weighted average rating vs every opponent we
 * expect to face. Positive = we favourably counter the field.
 */
export function counterScore(weapon: Weapon, lobbyWeapons: Partial<Record<Weapon, number>>): number {
  let total = 0;
  let n = 0;
  for (const [w, count] of Object.entries(lobbyWeapons) as [Weapon, number][]) {
    if (!count || count <= 0) continue;
    total += matchupRating(weapon, w) * count;
    n += count;
  }
  return n > 0 ? total / n : 0;
}

/**
 * Best counter-pick from `available` against the observed lobby, blending the
 * matchup edge with each weapon's standalone strength (metaScore, passed in as a
 * base map). Returns per-weapon breakdown sorted best-first so callers (and the
 * LLM prompt) can see the reasoning, not just the winner.
 */
export function rankCounterPicks(
  available: Weapon[],
  lobbyWeapons: Partial<Record<Weapon, number>>,
  baseScore: (w: Weapon) => number,
  counterWeight = 0.12,
): { weapon: Weapon; base: number; counter: number; total: number }[] {
  return available
    .map((weapon) => {
      const base = baseScore(weapon);
      const counter = counterScore(weapon, lobbyWeapons);
      return { weapon, base, counter, total: base + counter * counterWeight };
    })
    .sort((a, b) => b.total - a.total);
}
