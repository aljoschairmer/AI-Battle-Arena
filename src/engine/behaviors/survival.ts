import type { ClientAction, GridVec, NearbyBot } from "../../types/protocol";
import {
  chebyshev,
  dist,
  perpendicularStep,
  project,
  stepAwayFrom,
  stepToward,
  toUnitStep,
} from "../../shared/geometry";
import { profileFor } from "../weapons";
import { type DecisionContext, dodge, move, moveTo } from "./context";

/**
 * Top survival priority: don't die to the environment. Handles the shrinking
 * safe zone and standing in/next to hazards (burn fields, void, mines).
 * Returns an action only when survival actually demands one.
 */
export function survivalBehavior(ctx: DecisionContext): ClientAction | null {
  const { gs, tick } = ctx;
  const self = gs.self;
  if (!self) return null;

  // 1. Outside the safe zone — get back in. Zone damage stacks fast.
  if (!self.in_safe_zone) {
    return moveTo(tick, self.zone_center);
  }

  // 2. Zone is shrinking and we're near the edge — drift toward the next centre
  //    so we're never caught outside when it contracts.
  if (self.distance_to_zone_edge >= 0 && self.distance_to_zone_edge <= 3) {
    const target = self.zone_target_radius < self.zone_radius ? self.zone_target_center : self.zone_center;
    return moveTo(tick, target);
  }

  // 3. Standing on / adjacent to a hazard tile — step off to a safe neighbour.
  const hazards = gs.hazardTiles();
  if (hazards.length > 0) {
    const here = gs.position;
    const onHazard = hazards.some((h) => chebyshev(here, h) <= 1);
    if (onHazard) {
      const escape = safestNeighbourAway(ctx, hazards);
      if (escape) return move(tick, escape);
    }
  }

  return null;
}

/**
 * Reactive emergency dodge: spend a dodge (2 tiles + 3 ticks invuln) when a hit
 * is imminent AND we can't simply trade it back. The dodge has a 30-tick
 * cooldown, so we hoard it for the moments that matter — incoming charged shots,
 * or melee pressure while our own weapon is cooling down — rather than burning
 * it every time an enemy stands next to us. When our weapon is ready and a
 * target is in range we prefer to attack (handled by the combat layer).
 */
export function emergencyDodge(ctx: DecisionContext): ClientAction | null {
  const { gs, tick } = ctx;
  const self = gs.self;
  if (!self) return null;
  if (self.dodge_cooldown > 0 || self.invuln_ticks > 0 || self.stun_ticks > 0) return null;

  const me = gs.position;
  const myRange = gs.effectiveAttackRange();
  const enemies = gs.enemies();

  // Can we retaliate this tick instead of dodging?
  const canTradeNow =
    self.weapon_ready && enemies.some((e) => e.has_los && dist(me, e.position) <= myRange + 0.5);

  // The scariest single event: a charged ranged shot lined up on us.
  const chargedIncoming = enemies.find((e) => {
    const range = e.attack_range || profileFor(e.weapon).baseRange;
    return e.charged_shot_ready && e.has_los && dist(me, e.position) <= range + 2;
  });

  const justHit = self.hits_received.length > 0;
  const meleePressureNoRetaliate =
    !self.weapon_ready &&
    enemies.some((e) => e.can_attack && dist(me, e.position) <= 1.6);

  let trigger = false;
  if (chargedIncoming) trigger = true;
  else if (!canTradeNow && (justHit || meleePressureNoRetaliate)) trigger = true;
  if (!trigger) return null;

  const ref: NearbyBot | null = chargedIncoming ?? nearestAttacker(ctx) ?? gs.nearestEnemy();
  if (!ref) {
    // Hit by something we can't see (mine/AoE) — dodge toward zone centre.
    const dir = stepToward(me, self.zone_center);
    if (isDodgeWorthwhile(ctx, dir)) return dodge(tick, dir);
    return null;
  }

  const perp = perpendicularStep(me, ref.position);
  const away = stepAwayFrom(me, ref.position);
  for (const dir of [perp, [-perp[0], -perp[1]] as GridVec, away]) {
    if (isDodgeWorthwhile(ctx, dir)) return dodge(tick, dir);
  }
  return null;
}

/**
 * Retreat-and-heal: when below the directive's HP threshold, grab a nearby
 * health pack if one is reachable and safe, otherwise kite away from danger
 * toward the zone centre. Returns null when healthy enough to fight.
 */
export function retreatAndHeal(ctx: DecisionContext): ClientAction | null {
  const { gs, directive, tick } = ctx;
  const self = gs.self;
  if (!self) return null;

  const lowHp = gs.hpFraction() < directive.hpRetreatFraction;
  if (!lowHp && directive.posture !== "retreat") return null;

  const me = gs.position;

  // Prefer a health pack if it's close and not guarded by an adjacent enemy.
  const health = gs
    .pickups()
    .filter((p) => /health|hp|heal/i.test(p.pickup_type))
    .sort((a, b) => dist(me, a.position) - dist(me, b.position))[0];

  if (health && dist(me, health.position) <= 6 && !enemyAdjacentTo(gs.enemies(), health.position)) {
    return moveTo(tick, health.position);
  }

  // Otherwise kite: move away from the nearest threat, biased toward zone centre.
  const threat = gs.nearestEnemy();
  if (threat) {
    const away = stepAwayFrom(me, threat.position);
    const toCentre = stepToward(me, self.zone_center);
    const blended = toUnitStep([away[0] + toCentre[0], away[1] + toCentre[1]]);
    const step = firstSafeStep(ctx, [blended, away, toCentre]);
    if (step) return move(tick, step);
  }
  return moveTo(tick, self.zone_center);
}

// --- helpers ---------------------------------------------------------------

function enemyAdjacentTo(enemies: NearbyBot[], pos: GridVec): boolean {
  return enemies.some((e) => chebyshev(e.position, pos) <= 1);
}

/** The enemy most able to land damage on us this tick (for dodge direction). */
function nearestAttacker(ctx: DecisionContext): NearbyBot | null {
  const me = ctx.gs.position;
  let best: NearbyBot | null = null;
  let bestScore = 0;
  for (const e of ctx.gs.enemies()) {
    const d = dist(me, e.position);
    const range = e.attack_range || profileFor(e.weapon).baseRange;
    let score = 0;
    if (e.has_los && d <= range + 1 && e.can_attack) score += 50 - d;
    if (e.charged_shot_ready && e.has_los && d <= range + 2) score += 40;
    if (d <= 1.5) score += 20; // adjacent melee pressure
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  return best;
}

/** Would dodging in `dir` land us somewhere safe (in-bounds, passable, off-hazard)? */
function isDodgeWorthwhile(ctx: DecisionContext, dir: GridVec): boolean {
  if (dir[0] === 0 && dir[1] === 0) return false;
  const landing = project(ctx.gs.position, dir, 2, ctx.gs.gridSize);
  return ctx.gs.isSafeStep(landing[0], landing[1]);
}

/** Pick the immediate neighbour that maximises distance from all hazards. */
function safestNeighbourAway(ctx: DecisionContext, hazards: GridVec[]): GridVec | null {
  const me = ctx.gs.position;
  let best: GridVec | null = null;
  let bestClearance = -1;
  for (let dc = -1; dc <= 1; dc++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (dc === 0 && dr === 0) continue;
      const col = me[0] + dc;
      const row = me[1] + dr;
      if (!ctx.gs.isPassable(col, row)) continue;
      let clearance = Infinity;
      for (const h of hazards) clearance = Math.min(clearance, chebyshev([col, row], h));
      if (clearance > bestClearance) {
        bestClearance = clearance;
        best = [dc, dr];
      }
    }
  }
  return best;
}

/** Return the first direction from `dirs` that leads to a safe tile. */
function firstSafeStep(ctx: DecisionContext, dirs: GridVec[]): GridVec | null {
  for (const d of dirs) {
    if (d[0] === 0 && d[1] === 0) continue;
    const col = ctx.gs.position[0] + d[0];
    const row = ctx.gs.position[1] + d[1];
    if (ctx.gs.isSafeStep(col, row)) return d;
  }
  return null;
}
