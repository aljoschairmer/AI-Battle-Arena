import type { ClientAction, GridVec, NearbyBot } from "../../types/protocol";
import {
  DIRECTIONS8,
  chebyshev,
  dist,
  perpendicularStep,
  project,
  stepAwayFrom,
  stepToward,
  toUnitStep,
} from "../../shared/geometry";
import type { GameState } from "../gameState";
import { tradeAdvantage } from "../combatMath";
import { profileFor } from "../weapons";
import { telemetry } from "../telemetryLog";
import { type DecisionContext, dodge, grappleTo, move, moveTo, shove } from "./context";

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
  // Threat-field-aware: the field already scores "outside zone" as dangerous and
  // growing with distance (see ThreatField.build), so a local safestStep both
  // heads back toward the zone AND routes around enemy coverage on the way,
  // rather than a straight line that can walk through it. Only falls back to the
  // raw zone-centre move when no local step actually improves on standing still
  // (e.g. we're already at the best nearby tile and need the longer server path).
  if (!self.in_safe_zone) {
    const fieldStep = gs.threatField().safestStep(gs.position, (c, r) => gs.isSafeStep(c, r), true);
    if (fieldStep) return move(tick, fieldStep);
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

  const justHit = (self.hits_received ?? []).length > 0;
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
  const perpNeg: GridVec = [-perp[0] as number, -perp[1] as number];
  // Of the safe dodge directions, pick the one whose 2-tile landing sits in the
  // least dangerous tile (threat field) — don't dodge out of one bow's line
  // straight into another enemy's range.
  const field = gs.threatField();
  let bestDir: GridVec | null = null;
  let bestDanger = Number.POSITIVE_INFINITY;
  for (const dir of [perp, perpNeg, away]) {
    if (!isDodgeWorthwhile(ctx, dir)) continue;
    const landing = project(me, dir, 2, gs.gridSize);
    const dgr = field.danger(landing[0], landing[1]);
    if (dgr < bestDanger) {
      bestDanger = dgr;
      bestDir = dir;
    }
  }
  if (!bestDir) return null;

  logDodgeDecision(ctx, tick, me, field, bestDanger);
  return dodge(tick, bestDir);
}

/**
 * Telemetry only (Phase 2 audit): record the chosen landing tile's danger
 * alongside the true minimum across all 8 directions — the live decision
 * above only ever considers {perp, perpNeg, away} relative to one reference
 * enemy, so this measures whether a safer tile existed outside that narrower
 * candidate set, without changing which tile is actually picked.
 */
function logDodgeDecision(
  ctx: DecisionContext,
  tick: number,
  me: GridVec,
  field: ReturnType<GameState["threatField"]>,
  chosenTileDanger: number,
): void {
  let minAvailableDanger = chosenTileDanger;
  let candidateTileCount = 0;
  for (const dir of DIRECTIONS8) {
    if (!isDodgeWorthwhile(ctx, dir)) continue;
    candidateTileCount++;
    const landing = project(me, dir, 2, ctx.gs.gridSize);
    const dgr = field.danger(landing[0], landing[1]);
    if (dgr < minAvailableDanger) minAvailableDanger = dgr;
  }
  const dodgeId = String(tick);
  telemetry.dodgeDecision({ tick, dodgeId, chosenTileDanger, minAvailableDanger, candidateTileCount });
  ctx.gs.notePendingDodge(dodgeId, tick);
}

/**
 * Telemetry only (Phase 2 audit): resolve last tick's dodge (if any) now that
 * this tick's damage-taken is known — dodge outcomes land one tick after the
 * decision (see HitReceived on the following tick's self state).
 *
 * Called from Controller.decide() itself, before the can't-act guard — NOT
 * nested inside survivalBehavior — because survivalBehavior is unreachable on
 * a dead/stunned/respawning tick, and a dodge that gets us killed or stunned
 * on the very next tick is exactly the outcome this must not silently drop.
 */
export function resolvePendingDodge(gs: GameState, tick: number): void {
  const pending = gs.takePendingDodge();
  if (!pending) return;
  const damageTaken = (gs.self?.hits_received ?? []).reduce((sum, h) => sum + h.damage, 0);
  telemetry.dodgeResolved({ tick, dodgeId: pending.dodgeId, damageTaken });
}

/**
 * Retreat-and-heal: when below the directive's HP threshold, grab a nearby
 * health pack or kite away from danger toward zone center.
 */
export function retreatAndHeal(ctx: DecisionContext): ClientAction | null {
  const { gs, directive, tick } = ctx;
  const self = gs.self;
  if (!self) return null;

  // Trade-aware threshold: retreat earlier (higher effective HP%) against a
  // matchup we're currently losing, later against one we're winning, instead of
  // a single static cutoff regardless of who's actually chasing us.
  const threat = nearestAttacker(ctx) ?? gs.nearestEnemy();
  const tradeAdj = threat ? tradeAdvantage(ctx, threat) : 0;
  const effectiveRetreatFraction = Math.max(
    0,
    Math.min(1, directive.hpRetreatFraction - tradeAdj * ctx.policy.retreatTradeSensitivity),
  );
  const lowHp = gs.hpFraction() < effectiveRetreatFraction;
  if (!lowHp && directive.posture !== "retreat") return null;

  const me = gs.position;
  const hazards = gs.hasHazardKey() ? [] : gs.hazardTiles();

  const health = gs
    .pickups()
    .filter((p) => /health|hp|heal/i.test(p.pickup_type))
    // A pack sitting next to a hazard would just get us yanked back by
    // survivalBehavior (priority 2, above this) the instant we arrive — the two
    // behaviours would then fight over the same tile forever. Skip it so we
    // don't lock onto a target we can never actually stand on.
    .filter((p) => !hazardAdjacentTo(hazards, p.position))
    .sort((a, b) => dist(me, a.position) - dist(me, b.position))[0];

  if (health && dist(me, health.position) <= 9 && !enemyAdjacentTo(gs.enemies(), health.position)) {
    return moveTo(tick, health.position);
  }

  // Kite down the threat gradient: step toward the least dangerous adjacent tile
  // (accounts for ALL enemies + zone + hazards, not just the nearest one).
  const fieldStep = gs.threatField().safestStep(me, (c, r) => gs.isSafeStep(c, r), true);
  if (fieldStep) return move(tick, fieldStep);

  // Fallback: blend away-from-nearest with toward-centre when the field is flat.
  // Reuses the same reference threat computed above (nearestAttacker, falling
  // back to nearest) rather than recomputing a plain nearest-enemy.
  if (threat) {
    const away = gs.stepAwayFrom(threat.position);
    const toCentre = gs.stepToward(self.zone_center);
    const blended = toUnitStep([away[0] + toCentre[0], away[1] + toCentre[1]]);
    const step = firstSafeStep(ctx, [blended, away, toCentre]);
    if (step) return move(tick, step);
  }
  return moveTo(tick, self.zone_center);
}

/**
 * Tactical disengage: when the controller has picked a target but the trade is
 * unfavourable (outnumbered / out-DPS'd), step toward safer ground instead of
 * committing — but ONLY if our current tile is actually dangerous AND a strictly
 * safer step exists. If we're cornered (already at a local danger minimum), try
 * to actively create separation (shove an adjacent threat back, or grapple away
 * from a ranged one) before giving up and letting the combat layer fight a
 * trade we've already confirmed is bad.
 */
export function tacticalDisengage(ctx: DecisionContext): ClientAction | null {
  const { gs, tick } = ctx;
  const me = gs.position;
  const field = gs.threatField();
  if (field.danger(me[0], me[1]) < 1) return null;
  const step = field.safestStep(me, (c, r) => gs.isSafeStep(c, r), true);
  if (step) return move(tick, step);
  const safe = field.safestTileWithin(me, 4, (c, r) => gs.isPassable(c, r));
  if (safe[0] !== me[0] || safe[1] !== me[1]) return moveTo(tick, safe);

  return createSeparation(ctx);
}

/**
 * Cornered fallback for tacticalDisengage: no tile nearby is any safer, so
 * standing still and stepping away can't help. Instead of falling through to
 * fight, spend a universal special to buy an opening — shove an adjacent
 * threat back (2-tick stun, per docs/arena-spec.md) or grapple away from a
 * ranged one. Neither tool had a defensive use path anywhere in the engine
 * before this (see docs/audit/phase1-behavior-trace.md, combat.ts #7).
 */
function createSeparation(ctx: DecisionContext): ClientAction | null {
  if (!ctx.policy.disengageUseSeparation) return null;
  const { gs, tick } = ctx;
  const self = gs.self;
  if (!self) return null;
  const threat = nearestAttacker(ctx) ?? gs.nearestEnemy();
  if (!threat) return null;

  const me = gs.position;
  const d = dist(me, threat.position);
  if (d <= 1.5) return shove(tick, threat.bot_id);

  if (self.grapple_charges > 0 && self.grapple_cooldown <= 0) {
    const away = gs.stepAwayFrom(threat.position);
    const dest = project(me, away, 4, gs.gridSize);
    if (gs.isPassable(dest[0], dest[1])) return grappleTo(tick, dest);
  }
  return null;
}

// --- helpers ---------------------------------------------------------------

function enemyAdjacentTo(enemies: NearbyBot[], pos: GridVec): boolean {
  return enemies.some((e) => chebyshev(e.position, pos) <= 1);
}

/** Same radius survivalBehavior uses to trigger a hazard escape (see onHazard above). */
function hazardAdjacentTo(hazards: GridVec[], pos: GridVec): boolean {
  return hazards.some((h) => chebyshev(pos, h) <= 2);
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
