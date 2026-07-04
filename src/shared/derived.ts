import type { StatBlock, Weapon } from "../types/protocol";
import { normalizeStats } from "./stats";

/**
 * Exact server-side stat formulas, reverse-engineered from the arena's public
 * **Stat Simulator** (the "Simulator" tab on arena.angel-serv.com).
 *
 * Verified against its published numbers for the neutral 5/5/5/5 sword build:
 *   max_hp 150 · speed 5.5 · atk_mult 1.5x · def_red 15% · effective_hp 176
 * and its DPS table (sword base 23.18, cd 0.47s):
 *   def0 → 34.77 dmg/hit (73.98 dps) · def5 → 29.55 · def10 → 24.34.
 *
 * Keeping these in one place lets the OFFLINE code (loadout chooser, self-play
 * simulator, LLM context) reason about *any* build precisely, without waiting
 * for the server to echo `loadout_confirmed.computed` for one specific build.
 */

// max_hp   = 100 + 10*hp        (hp 1..10  → 110..200)
export const MAX_HP_BASE = 100;
export const MAX_HP_PER_POINT = 10;
// speed    = 3 + 0.5*speed      (speed 1..10 → 3.5..8.0 tiles/s)
export const SPEED_BASE = 3;
export const SPEED_PER_POINT = 0.5;
// atk_mult = 1 + 0.1*attack     (attack 1..10 → 1.1..2.0)
export const ATK_MULT_PER_POINT = 0.1;
// def_red  = 0.03*defense       (defense 1..10 → 3%..30%, capped at 30%)
export const DEF_RED_PER_POINT = 0.03;

/** A neutral reference opponent (the simulator's default sliders). */
export const NEUTRAL_STATS: StatBlock = { hp: 5, speed: 5, attack: 5, defense: 5 };

export interface DerivedStats {
  maxHp: number;
  speed: number;
  attackMult: number;
  /** Fraction of incoming damage negated, 0..0.30. */
  defenseRed: number;
  /**
   * Effective HP = max_hp / (1 - def_red). This is the true survivability
   * number: your time-to-die against any attacker is (effectiveHp / their raw
   * DPS), so a build with 200 HP and 30% reduction soaks 286 raw damage.
   */
  effectiveHp: number;
}

export function attackMult(attackStat: number): number {
  return 1 + ATK_MULT_PER_POINT * attackStat;
}

export function defenseRed(defenseStat: number): number {
  return Math.min(0.3, DEF_RED_PER_POINT * defenseStat);
}

export function deriveStats(s: StatBlock): DerivedStats {
  const maxHp = MAX_HP_BASE + MAX_HP_PER_POINT * s.hp;
  const dRed = defenseRed(s.defense);
  return {
    maxHp,
    speed: SPEED_BASE + SPEED_PER_POINT * s.speed,
    attackMult: attackMult(s.attack),
    defenseRed: dRed,
    effectiveHp: maxHp / (1 - dRed),
  };
}

/** Damage a single hit lands (weapon base × our atk_mult × target's mitigation). */
export function damagePerHit(weaponBaseDamage: number, attackStat: number, targetDefenseStat: number): number {
  return weaponBaseDamage * attackMult(attackStat) * (1 - defenseRed(targetDefenseStat));
}

/** Sustained DPS of a build into a target of the given defense stat. */
export function dpsInto(
  weaponBaseDamage: number,
  cooldownSeconds: number,
  attackStat: number,
  targetDefenseStat: number,
): number {
  if (cooldownSeconds <= 0) return 0;
  return damagePerHit(weaponBaseDamage, attackStat, targetDefenseStat) / cooldownSeconds;
}

/**
 * Fight power = effective_hp × dmg-per-hit into a neutral opponent. Proportional
 * to (survival time × damage output), i.e. how many neutral opponents this build
 * beats before dying. The weapon's base/cooldown scale it uniformly, so the
 * argmax *stat spread* is weapon-independent (it depends only on the budget and
 * on how much speed you reserve for positioning).
 *
 * Insight it captures: because effective_hp already fully credits defense, and
 * defense only buys 3%/point (capped at 30%), fight power is maximized by
 * splitting the budget ~evenly between HP and attack and keeping defense low —
 * NOT by stacking defense. Speed is orthogonal to raw fight power but essential
 * for actually reaching (melee) or kiting (ranged) the fight.
 */
export function fightPower(weaponBaseDamage: number, cooldownSeconds: number, stats: StatBlock): number {
  const eHp = deriveStats(stats).effectiveHp;
  return eHp * dpsInto(weaponBaseDamage, cooldownSeconds, stats.attack, NEUTRAL_STATS.defense);
}

export interface OptimizeOpts {
  budget?: number;
  min?: number;
  max?: number;
  /** Minimum speed to reserve (mobility floor for the weapon's playstyle). */
  speedFloor?: number;
  /** Minimum defense to keep (a small durability hedge vs ganks/zone chip). */
  defenseFloor?: number;
}

/**
 * Brute-force the fight-power-optimal legal stat spread. Fully deterministic and
 * cheap (a few hundred integer combos). We honour a per-weapon speed floor (so
 * the "optimal" build can still close/kite) and a small defense floor, then let
 * the sweep place the rest — which, per fightPower above, lands near hp≈attack
 * with minimal defense.
 */
export function optimizeBuild(
  weaponBaseDamage: number,
  cooldownSeconds: number,
  opts: OptimizeOpts = {},
): StatBlock {
  const budget = opts.budget ?? 20;
  const min = opts.min ?? 1;
  const max = opts.max ?? 10;
  const speedFloor = Math.max(min, opts.speedFloor ?? min);
  const defenseFloor = Math.max(min, opts.defenseFloor ?? min);

  let best: StatBlock | null = null;
  let bestScore = -Infinity;
  for (let speed = speedFloor; speed <= max; speed++) {
    for (let defense = defenseFloor; defense <= max; defense++) {
      for (let hp = min; hp <= max; hp++) {
        const attack = budget - speed - defense - hp;
        if (attack < min || attack > max) continue;
        const stats: StatBlock = { hp, speed, attack, defense };
        const score = fightPower(weaponBaseDamage, cooldownSeconds, stats);
        if (score > bestScore) {
          bestScore = score;
          best = stats;
        }
      }
    }
  }
  // Fall back to a legal neutral spread if the constraints admit nothing.
  return best ?? normalizeStats(NEUTRAL_STATS, budget, min, max);
}

/** Per-weapon mobility/durability floors used when optimizing a spread. */
export const BUILD_FLOORS: Record<Weapon, { speedFloor: number; defenseFloor: number }> = {
  sword: { speedFloor: 5, defenseFloor: 2 }, // bruiser: chase + trade
  daggers: { speedFloor: 6, defenseFloor: 2 }, // hit-and-run, needs to reposition
  shield: { speedFloor: 4, defenseFloor: 4 }, // tank identity keeps real defense
  spear: { speedFloor: 5, defenseFloor: 2 }, // reach + brace
  bow: { speedFloor: 5, defenseFloor: 2 }, // must kite to survive
  staff: { speedFloor: 5, defenseFloor: 2 }, // reposition to keep AoE range
  grapple: { speedFloor: 6, defenseFloor: 2 }, // mobility tool
};
