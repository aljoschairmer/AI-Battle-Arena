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

  // 1. Outside the safe zone — get back in immediately. Zone damage stacks fast.
  if (!self.in_safe_zone) {
    return moveTo(tick, self.zone_center);
  }

  // 2. Zone is shrinking toward a new center — drift proactively so we're never
  //    caught at the edge when the boundary snaps. Only trigger when the zone IS
  //    actually contracting (target_radius < current radius) and we're close to
  //    the current edge.
  const zoneShrinking = self.zone_target_radius < self.zone_radius;
  if (zoneShrinking && self.distance_to_zone_edge >= 0 && self.distance_to_zone_edge <= ctx.policy.zoneEdgeMargin) {
    return moveTo(tick, self.zone_target_center);
  }

  // 3. Standing near a hazard tile — step off, UNLESS we have the hazard key active.
  if (!gs.hasHazardKey()) {
    const hazards = gs.hazardTiles();
    if (hazards.length > 0) {
      const here = gs.position;
      const onHazard = hazards.some((h) => chebyshev(here, h) <= 2);
      if (onHazard) {
        const escape = safestNeighbourAway(ctx, hazards);
        if (escape) return move(tick, escape);
      }
    }
  }

  // 4. Burning / DoT'd and no health pack close — kite toward zone center while
  //    the pickup layer handles healing. Burning in place is always worse than
  //    moving (burn fields persist, so just walk off them).
  if (gs.hasNegativeEffect()) {
    const here = gs.position;
    const onBurn = gs.burnFields().some((b) => chebyshev(here, b.position) <= 1);
    if (onBurn) {
      const escape = safestNeighbourAway(ctx, gs.burnFields().map((b) => b.position));
      if (escape) return move(tick, escape);
    }
  }

  return null;
}

/**
 * Emergency dodge: spend the 30-tick dodge (2 tiles, 3 ticks invuln) when a hit
 * is imminent and retaliating now wouldn't be worth it.
 *
 * Extended triggers vs. original:
 *   - charged bow shot lined up on us (was already there)
 *   - enemy bow at high charge level even without charged_shot_ready (imminent)
 *   - melee pressure while our weapon is cooling
 *   - just took a hit and can't trade back immediately
 */
export function emergencyDodge(ctx: DecisionContext): ClientAction | null {
  const { gs, tick } = ctx;
  const self = gs.self;
  if (!self) return null;
  if (self.dodge_cooldown > 0 || self.invuln_ticks > 0 || self.stun_ticks > 0) return null;

  const me = gs.position;
  const myRange = gs.effectiveAttackRange();
  const enemies = gs.enemies();

  // Fully charged shot about to fire.
  const chargedIncoming = enemies.find((e) => {
    const range = e.attack_range || profileFor(e.weapon).baseRange;
    return e.charged_shot_ready && e.has_los && dist(me, e.position) <= range + 2;
  });

  // Bow enemy at charge level 2+ — fire is imminent; dodge before the shot lands.
  const highChargeBow: NearbyBot | null = chargedIncoming
    ? null
    : enemies.find((e) => {
        const range = e.attack_range || profileFor(e.weapon).baseRange;
        return e.weapon === "bow" && e.bow_charge_level >= 2 && e.has_los && dist(me, e.position) <= range + 1;
      }) ?? null;

  const justHit = self.hits_received.length > 0;
  // Melee pressure: dodge whenever an enemy can attack us in melee, regardless
  // of whether our own weapon is ready. Trading hits at 1:1 is always losing
  // when the enemy has more HP or is part of a cluster.
  const meleePressure = enemies.some((e) => e.can_attack && dist(me, e.position) <= 1.6);

  // dodgeEagerness (0..1, LLM-tunable) gates how twitchy we are. A charged shot
  // is always worth dodging; lesser threats only trip the dodge as eagerness rises.
  const eager = ctx.policy.dodgeEagerness;
  let trigger = false;
  if (chargedIncoming) trigger = true;
  else if (highChargeBow && eager >= 0.3) trigger = true;
  else if ((justHit || meleePressure) && eager >= 0.5) trigger = true;
  if (!trigger) return null;

  const ref: NearbyBot | null = chargedIncoming ?? highChargeBow ?? nearestAttacker(ctx) ?? gs.nearestEnemy();
  if (!ref) {
    const dir = stepToward(me, self.zone_center);
    if (isDodgeWorthwhile(ctx, dir)) return dodge(tick, dir);
    return null;
  }

  const perp = perpendicularStep(me, ref.position);
  const away = stepAwayFrom(me, ref.position);
  // Try both perpendicular directions, then straight away — pick first safe one.
  const perpNeg: GridVec = [-perp[0] as number, -perp[1] as number];
  for (const dir of [perp, perpNeg, away]) {
    if (isDodgeWorthwhile(ctx, dir)) return dodge(tick, dir);
  }
  return null;
}

/**
 * Retreat-and-heal: when below the directive's HP threshold, grab a nearby
 * health pack or kite away from danger toward zone center.
 */
export function retreatAndHeal(ctx: DecisionContext): ClientAction | null {
  const { gs, directive, tick } = ctx;
  const self = gs.self;
  if (!self) return null;

  const lowHp = gs.hpFraction() < directive.hpRetreatFraction;
  if (!lowHp && directive.posture !== "retreat") return null;

  const me = gs.position;

  const health = gs
    .pickups()
    .filter((p) => /health|hp|heal/i.test(p.pickup_type))
    .sort((a, b) => dist(me, a.position) - dist(me, b.position))[0];

  if (health && dist(me, health.position) <= 9 && !enemyAdjacentTo(gs.enemies(), health.position)) {
    return moveTo(tick, health.position);
  }

  // Kite: move away from nearest threat using wall-aware steps, biased toward zone center.
  const threat = gs.nearestEnemy();
  if (threat) {
    const away = gs.stepAwayFrom(threat.position);
    const toCentre = gs.stepToward(self.zone_center);
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
    if (e.bow_charge_level >= 3 && e.has_los && d <= range + 1) score += 30;
    if (d <= 1.5) score += 20;
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return best;
}

function isDodgeWorthwhile(ctx: DecisionContext, dir: GridVec): boolean {
  if (dir[0] === 0 && dir[1] === 0) return false;
  const landing = project(ctx.gs.position, dir, 2, ctx.gs.gridSize);
  return ctx.gs.isSafeStep(landing[0], landing[1]);
}

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
      if (clearance > bestClearance) { bestClearance = clearance; best = [dc, dr]; }
    }
  }
  return best;
}

function firstSafeStep(ctx: DecisionContext, dirs: GridVec[]): GridVec | null {
  for (const d of dirs) {
    if (d[0] === 0 && d[1] === 0) continue;
    const col = ctx.gs.position[0] + d[0];
    const row = ctx.gs.position[1] + d[1];
    if (ctx.gs.isSafeStep(col, row)) return d;
  }
  return null;
}
