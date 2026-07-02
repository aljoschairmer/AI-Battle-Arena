import type { NearbyBot } from "../../types/protocol";
import { dist } from "../../shared/geometry";
import { tradeAdvantage } from "../combatMath";
import { matchupRating } from "../matchups";
import { telemetry } from "../telemetryLog";
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
  if (enemies.length === 0) {
    logSwitch(ctx, null, "no_enemies_visible");
    return null;
  }

  const avoid = new Set(directive.avoidTargetIds);

  // Honour the Brain's kill order only if the target scores well enough to be
  // worth it — don't blindly charge a full-HP, high-threat bot behind a wall.
  if (directive.primaryTargetId) {
    const preferred = enemies.find((e) => e.bot_id === directive.primaryTargetId);
    if (preferred && !avoid.has(preferred.bot_id)) {
      const preferredScore = scoreEnemy(ctx, preferred, dist(me, preferred.position));
      // Accept the Brain's pick unless it scores very poorly (negative = dangerous/unreachable).
      if (preferredScore > -10) {
        logSwitch(ctx, preferred, "forced_target");
        return preferred;
      }
    }
  }

  let best: NearbyBot | null = null;
  let bestScore = -Infinity;
  const scored = new Map<string, number>();

  for (const e of enemies) {
    if (avoid.has(e.bot_id)) continue;
    const score = scoreEnemy(ctx, e, dist(me, e.position));
    scored.set(e.bot_id, score);
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }

  // Debounce: stick with the currently-selected target unless it's no longer
  // valid (dead / out of fog / newly avoided — not in `scored`) or a challenger
  // clears its score by a real margin. Without this, tiny per-tick score noise
  // between similarly-ranked enemies flips the target every tick — confirmed in
  // play (Phase 2: 24% of switches land under 500ms apart with no debounce at
  // all), wasting flank/approach progress restarted from scratch each flip.
  // Only applies to this scored fallback, not the Brain's forced-target branch
  // above — an explicit directive should take effect immediately.
  let reason = "best_scored";
  const currentId = gs.currentTargetId();
  if (best && currentId && currentId !== best.bot_id && scored.has(currentId)) {
    if (bestScore - scored.get(currentId)! < ctx.policy.targetSwitchHysteresis) {
      best = enemies.find((e) => e.bot_id === currentId) ?? best;
      reason = "stuck_hysteresis";
    }
  }

  // If everything is on the avoid list, fall back to nearest so we still fight.
  const result = best ?? gs.nearestEnemy();
  logSwitch(ctx, result, best ? reason : "fallback_nearest_all_avoided");
  return result;
}

/**
 * Telemetry only: log a target-switch event iff the pick differs from last
 * tick's (Phase 2 audit — selectTarget itself carries no other state and its
 * scoring/fallback behaviour above is unchanged).
 */
function logSwitch(ctx: DecisionContext, target: NearbyBot | null, reason: string): void {
  const { gs, tick } = ctx;
  const toId = target?.bot_id ?? null;
  const { switched, fromId, ticksSinceLastSwitch } = gs.noteTargetSelection(toId, tick);
  if (!switched) return;
  telemetry.targetSwitch({ tick, fromTargetId: fromId, toTargetId: toId, ticksSinceLastSwitch, reason });
}

function scoreEnemy(ctx: DecisionContext, e: NearbyBot, distance: number): number {
  const { gs, directive, policy } = ctx;
  const hpFrac = e.max_hp > 0 ? e.hp / e.max_hp : 1;

  let score = 0;

  // Prefer low-HP, finishable targets — biggest single factor (LLM-tunable weight).
  score += (1 - hpFrac) * policy.targetLowHpWeight;

  // Weapon matchup (matchups.ts, -2..+2): break ties toward the enemy our
  // weapon hard-counters rather than treating all equally-tempting targets as
  // interchangeable. Enemy weapon type is known with certainty every tick
  // (Phase 0 finding — no fog-of-war ambiguity here, unlike trade math), so
  // this was previously unwired data, not unavailable data.
  if (gs.self) score += matchupRating(gs.self.weapon, e.weapon) * policy.targetMatchupWeight;

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

  // Favour fights we expect to win (forward trade estimate), penalise losing
  // ones. Weight is LLM-tunable like every sibling weight in this function —
  // it was the last hardcoded one (pass-2 audit T1).
  score += tradeAdvantage(ctx, e) * policy.targetTradeWeight;

  // Bounty: a target that actually carries the bounty is worth extra risk
  // regardless of objective (bounty kills are direct score). The live tick
  // beacon makes this precise (isBountyTarget checks it first, then the REST
  // board); the old hunt_bounty +15-for-anyone heuristic below only applies
  // when we genuinely don't know who the carrier is.
  const isCarrier = gs.isBountyTarget(e.bot_id, e.name);
  if (isCarrier) score += policy.targetBountyWeight;

  // Third-party read (live target_id, pass-4): an enemy locked onto someone
  // else is distracted — cheap damage for us. One locked onto US is actively
  // hunting us; fold that into the threat side so the aversion math sees it.
  if (e.target_id) {
    if (e.target_id === gs.selfId) score -= policy.targetThreatAversion * 0.2;
    else if (e.target_id !== "") score += policy.targetDistractedBonus;
  }

  // Objective overrides.
  if (directive.objective === "engage_weakest") score += (1 - hpFrac) * 40;
  if (directive.objective === "survive") score -= Math.max(0, distance - 2) * 6;
  if (directive.objective === "hunt_bounty") {
    // Known carrier in sight: hunt THAT bot. Unknown carrier: the old
    // any-active-enemy nudge (board unfetchable and no beacon).
    if (isCarrier) score += 15;
    else if (gs.bountyBeacon === null && e.threat_score > 0) score += 15;
  }

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
