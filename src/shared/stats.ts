import type { StatBlock } from "../types/protocol";

const KEYS: (keyof StatBlock)[] = ["hp", "speed", "attack", "defense"];

/**
 * Coerce an arbitrary (possibly LLM-produced) stat block into a legal one:
 * every stat an integer within [min, max], and the four summing exactly to the
 * budget. This guarantees the server never rejects our select_loadout.
 */
export function normalizeStats(
  input: Partial<Record<keyof StatBlock, number>>,
  budget = 20,
  min = 1,
  max = 10,
): StatBlock {
  const stats: StatBlock = {
    hp: clampInt(input.hp, min, max),
    speed: clampInt(input.speed, min, max),
    attack: clampInt(input.attack, min, max),
    defense: clampInt(input.defense, min, max),
  };

  let sum = KEYS.reduce((s, k) => s + stats[k], 0);

  // Add points to the highest stats first (preserve intent), respecting max.
  while (sum < budget) {
    const k = pickAdjustable(stats, max, true);
    if (!k) break;
    stats[k] += 1;
    sum += 1;
  }
  // Remove points from the lowest stats first, respecting min.
  while (sum > budget) {
    const k = pickAdjustable(stats, min, false);
    if (!k) break;
    stats[k] -= 1;
    sum -= 1;
  }
  return stats;
}

function clampInt(v: number | undefined, min: number, max: number): number {
  const n = Number.isFinite(v) ? Math.round(v as number) : min;
  return Math.max(min, Math.min(max, n));
}

function pickAdjustable(stats: StatBlock, bound: number, adding: boolean): keyof StatBlock | null {
  let best: keyof StatBlock | null = null;
  let bestVal = adding ? -Infinity : Infinity;
  for (const k of KEYS) {
    const v = stats[k];
    if (adding && v >= bound) continue;
    if (!adding && v <= bound) continue;
    if (adding ? v > bestVal : v < bestVal) {
      bestVal = v;
      best = k;
    }
  }
  return best;
}
