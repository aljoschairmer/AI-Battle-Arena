import type { NearbyBot } from "../../types/protocol";
import { dist } from "../../shared/geometry";
import type { DecisionContext } from "./context";

/**
 * Target selection. Scores visible enemies by killability and strategic value,
 * honouring the Brain's directive (preferred target / avoid list / objective).
 *
 * Higher score = better target. Pure function of the current frame so it's
 * cheap to run every tick.
 */
export function selectTarget(ctx: DecisionContext): NearbyBot | null {
  const { gs, directive } = ctx;
  const me = gs.position;
  const enemies = gs.enemies();
  if (enemies.length === 0) return null;

  const avoid = new Set(directive.avoidTargetIds);

  // Honour the Brain's kill order only if the target scores well enough to be
  // worth it — don't blindly charge a full-HP, high-threat bot behind a wall.
  if (directive.primaryTargetId) {
    const preferred = enemies.find((e) => e.bot_id === directive.primaryTargetId);
    if (preferred && !avoid.has(preferred.bot_id)) {
      const preferredScore = scoreEnemy(ctx, preferred, dist(me, preferred.position));
      // Accept the Brain's pick unless it scores very poorly (negative = dangerous/unreachable).
      if (preferredScore > -10) return preferred;
    }
  }

  let best: NearbyBot | null = null;
  let bestScore = -Infinity;

  for (const e of enemies) {
    if (avoid.has(e.bot_id)) continue;
    const score = scoreEnemy(ctx, e, dist(me, e.position));
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  // If everything is on the avoid list, fall back to nearest so we still fight.
  return best ?? gs.nearestEnemy();
}

function scoreEnemy(ctx: DecisionContext, e: NearbyBot, distance: number): number {
  const { directive, policy } = ctx;
  const hpFrac = e.max_hp > 0 ? e.hp / e.max_hp : 1;

  let score = 0;

  // Prefer low-HP, finishable targets — biggest single factor (LLM-tunable weight).
  score += (1 - hpFrac) * policy.targetLowHpWeight;

  // Prefer closer targets. Linear decay so distance always matters, not just < 10 tiles.
  score += Math.max(0, 40 - distance * policy.targetCloseWeight);

  // Exploitable openings.
  if (e.rear_exposed) score += 20;
  if (e.is_stunned) score += 30;
  if (e.near_impact_surface) score += 10;
  if (!e.can_attack) score += 12; // weapon on cooldown — safe window

  // No LOS = can't attack them right now; strong penalty.
  if (!e.has_los) score -= 25;

  // Target is dodging — immune to damage this tick; avoid wasting the action.
  if (e.is_dodging) score -= 20;

  // Threat score: normalise to 0..1 range assuming 0..10 scale, then penalise
  // proportionally to how non-aggressive we are.
  const normThreat = Math.min(1, e.threat_score / 10);
  const threatPenalty = normThreat * (policy.targetThreatAversion + (1 - directive.aggression) * 30);
  score -= threatPenalty;

  // Objective overrides.
  if (directive.objective === "engage_weakest") score += (1 - hpFrac) * 40;
  if (directive.objective === "survive") score -= Math.max(0, distance - 2) * 6;
  if (directive.objective === "hunt_bounty" && e.threat_score > 0) score += 15; // bounty targets worth risk

  return score;
}

/** Centroid of clustered enemies — good aim point for AoE / gravity well. */
export function enemyCluster(ctx: DecisionContext, withinTiles = 4): [number, number] | null {
  const enemies = ctx.gs.enemies();
  if (enemies.length < 2) return null;
  const me = ctx.gs.position;
  const near = enemies.filter((e) => dist(me, e.position) <= ctx.gs.fogRadius);
  if (near.length < 2) return null;

  let sx = 0;
  let sy = 0;
  for (const e of near) {
    sx += e.position[0];
    sy += e.position[1];
  }
  const cx = Math.round(sx / near.length);
  const cy = Math.round(sy / near.length);
  // Only worth it if at least two enemies sit close to the centroid.
  const clustered = near.filter((e) => dist([cx, cy], e.position) <= withinTiles).length;
  return clustered >= 2 ? [cx, cy] : null;
}
