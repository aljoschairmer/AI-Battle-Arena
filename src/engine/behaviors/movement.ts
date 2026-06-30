import type { ClientAction, GridVec, NearbyBot, NearbyPickup } from "../../types/protocol";
import {
  dist,
  perpendicularStep,
  toUnitStep,
} from "../../shared/geometry";
import { profileFor } from "../weapons";
import { type DecisionContext, move, moveTo, sprintTo } from "./context";

/**
 * Positioning relative to a target. Melee bots close in; ranged bots hold near
 * their preferred range and kite/strafe to stay alive while dealing damage.
 *
 * Daggers: tries to circle to the rear of the target (rear_exposed gives backstab bonus).
 */
export function positionForCombat(ctx: DecisionContext, target: NearbyBot): ClientAction {
  const { gs, tick } = ctx;
  const self = gs.self!;
  const me = gs.position;
  const d = dist(me, target.position);
  const profile = profileFor(self.weapon);

  if (!profile.ranged) {
    // Daggers: try to get behind the target for backstab bonus
    if (self.weapon === "daggers" && !target.rear_exposed) {
      const behind = flankingPosition(me, target.position);
      if (behind && gs.isPassable(behind[0], behind[1])) {
        return moveTo(tick, behind);
      }
    }
    return moveTo(tick, target.position);
  }

  const range = gs.effectiveAttackRange();
  const preferred = Math.min(profile.preferredRange, range);

  // Too close — back off to open the gap (kite), wall-aware.
  if (d < preferred - 0.5) {
    const away = gs.stepAwayFrom(target.position);
    const perp = perpendicularStep(me, target.position);
    const step = pickSafe(ctx, [away, safePerp(perp), safePerp([-perp[0], -perp[1]] as GridVec)]);
    if (step) return move(tick, step);
  }

  // Too far — advance to get into firing range.
  if (d > range + 0.25) {
    return moveTo(tick, target.position);
  }

  // In the sweet spot — strafe perpendicular to be a harder target.
  const perp = perpendicularStep(me, target.position);
  const step = pickSafe(ctx, [safePerp(perp), safePerp([-perp[0], -perp[1]] as GridVec)]);
  if (step) return move(tick, step);

  // Nowhere safe to strafe — hold position aimed at the target.
  return moveTo(tick, target.position);
}

const PICKUP_VALUE: Record<string, number> = {
  health: 1.0,
  hp: 1.0,
  heal: 1.0,
  shield: 0.9,    // absorbs next hit — nearly as good as healing
  hazard: 0.85,   // suppresses ALL zone/burn/void damage — huge in hazard rounds
  gravity: 0.75,  // cluster control — strong for staff/grapple
  speed: 0.7,     // mobility is survivability
  grapple: 0.65,
  cooldown: 0.6,
  bounty: 0.55,
  overdrive: 0.5, // attack speed luxury — not worth much when low HP
  damage: 0.4,    // pure damage luxury — being alive matters more
  attack: 0.4,
  relay: 0.3,
};

function pickupScore(type: string): number {
  const t = type.toLowerCase();
  for (const [key, val] of Object.entries(PICKUP_VALUE)) {
    if (t.includes(key)) return val;
  }
  return 0.35;
}

/**
 * Opportunistically grab a nearby, valuable, safe pickup.
 * When burning/DoT'd, heavily prioritizes health pickups regardless of distance.
 */
export function grabPickup(ctx: DecisionContext): ClientAction | null {
  const { gs, tick, directive } = ctx;
  const me = gs.position;
  const pickups = gs.pickups();
  if (pickups.length === 0) return null;

  const burning = gs.hasNegativeEffect();
  // Flat detour budget regardless of aggression — being alive to fight is always worth a small detour.
  const maxDetour = burning ? 10 : directive.posture === "defensive" || directive.posture === "retreat" ? 8 : 6;

  let best: NearbyPickup | null = null;
  let bestScore = -Infinity;

  for (const p of pickups) {
    const d = dist(me, p.position);
    // When burning, only prioritize health; otherwise use detour budget
    const isHealth = /health|hp|heal/i.test(p.pickup_type);
    const effectiveMax = burning && isHealth ? 10 : maxDetour;
    if (d > effectiveMax) continue;
    if (enemyControls(gs.enemies(), p.position)) continue;
    const score = pickupScore(p.pickup_type) * 10 - d;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  if (!best) return null;

  if (dist(me, best.position) <= 0.75) {
    return { type: "action", tick, action: "use_item", item_id: best.pickup_id };
  }
  return moveTo(tick, best.position);
}

/**
 * Nothing to fight and nothing to grab: pre-position for the shrinking zone.
 * Priorities:
 *   1. control_center objective → move toward capture pad if visible
 *   2. Search last-seen enemies
 *   3. Drift toward zone target center
 */
export function defaultReposition(ctx: DecisionContext): ClientAction {
  const { gs, tick, directive } = ctx;
  const self = gs.self!;

  // control_center objective: head toward the capture pad
  if (directive.objective === "control_center") {
    const cap = gs.nearestCapturePad();
    if (cap) return moveTo(tick, cap);
  }

  const search = searchLastSeenEnemy(ctx);
  if (search) return search;

  // No enemies nearby — loot valuable pickups before patrolling.
  const loot = seekPickup(ctx);
  if (loot) return loot;

  // Nothing to loot either — patrol the zone to find enemies.
  const zoneCenter =
    self.zone_target_radius < self.zone_radius ? self.zone_target_center : self.zone_center;
  const patrolTarget = patrolPoint(gs, tick, zoneCenter);
  return moveTo(tick, patrolTarget);
}

/**
 * When no enemies are visible, route toward the best visible pickup regardless
 * of detour distance. Health is top priority; any pickup beats aimless patrol.
 * Still skips pickups an enemy is camping (within 1.5 tiles).
 */
function seekPickup(ctx: DecisionContext): ClientAction | null {
  const { gs, tick } = ctx;
  const me = gs.position;
  const pickups = gs.pickups();
  if (pickups.length === 0) return null;

  let best: NearbyPickup | null = null;
  let bestScore = -Infinity;

  for (const p of pickups) {
    if (enemyControls(gs.enemies(), p.position)) continue;
    const d = dist(me, p.position);
    const score = pickupScore(p.pickup_type) * 10 - d * 0.5;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  if (!best) return null;

  if (dist(me, best.position) <= 0.75) {
    return { type: "action", tick, action: "use_item", item_id: best.pickup_id };
  }
  return moveTo(tick, best.position);
}

/**
 * Pick a patrol waypoint offset from the zone center, rotating through 8
 * compass directions every 30 ticks. The offset is 40% of the current zone
 * radius so the bot sweeps a wide arc without leaving the zone.
 */
function patrolPoint(gs: import("../gameState").GameState, tick: number, center: GridVec): GridVec {
  const OFFSETS: GridVec[] = [
    [1, 0], [1, 1], [0, 1], [-1, 1],
    [-1, 0], [-1, -1], [0, -1], [1, -1],
  ];
  const self = gs.self!;
  const radius = Math.max(4, (self.zone_radius ?? 20) * 0.4);
  const slot = Math.floor(tick / 30) % OFFSETS.length;
  const [dx, dy] = OFFSETS[slot]!;
  const col = Math.round(center[0] + dx * radius);
  const row = Math.round(center[1] + dy * radius);
  const clamped: GridVec = [
    Math.max(0, Math.min(gs.gridSize - 1, col)),
    Math.max(0, Math.min(gs.gridSize - 1, row)),
  ];
  return gs.isPassable(clamped[0], clamped[1]) ? clamped : center;
}

function searchLastSeenEnemy(ctx: DecisionContext): ClientAction | null {
  const { gs, tick } = ctx;
  if (gs.enemies().length > 0) return null;

  const lastSeen = gs.guessedEnemyPositions(30).sort((a, b) => a.since - b.since);
  if (lastSeen.length === 0) return null;

  const target = lastSeen[0]!;
  const preferSprint = !gs.terrain || gs.isPassable(target.position[0], target.position[1]);
  return preferSprint ? sprintTo(tick, target.position) : moveTo(tick, target.position);
}

// --- helpers ---------------------------------------------------------------

function enemyControls(enemies: NearbyBot[], pos: GridVec): boolean {
  return enemies.some((e) => dist(e.position, pos) <= 1.5);
}

function pickSafe(ctx: DecisionContext, dirs: GridVec[]): GridVec | null {
  for (const d of dirs) {
    if (d[0] === 0 && d[1] === 0) continue;
    const col = ctx.gs.position[0] + d[0];
    const row = ctx.gs.position[1] + d[1];
    if (ctx.gs.isSafeStep(col, row)) return d;
  }
  // Last resort: blend toward zone centre so we never freeze.
  const self = ctx.gs.self;
  if (self) {
    const toCentre = toUnitStep([
      self.zone_center[0] - ctx.gs.position[0],
      self.zone_center[1] - ctx.gs.position[1],
    ]);
    if (toCentre[0] !== 0 || toCentre[1] !== 0) return toCentre;
  }
  return null;
}

/** Guard against zero-vector perpendicular (target directly on same row/col). */
function safePerp(perp: GridVec): GridVec {
  if (perp[0] !== 0 || perp[1] !== 0) return perp;
  return [1, 0]; // fallback: step right
}

/**
 * Compute a flanking position behind the target for dagger backstab.
 * "Behind" = opposite direction of the target's facing, offset 1 tile.
 */
function flankingPosition(me: GridVec, targetPos: GridVec): GridVec | null {
  // Approach from the side opposite to where we currently are relative to the target
  const dx = me[0] - targetPos[0];
  const dy = me[1] - targetPos[1];
  // Go around: perpendicular to the current approach angle
  if (Math.abs(dx) >= Math.abs(dy)) {
    // We're left/right — go above or below
    return [targetPos[0], targetPos[1] + (dy >= 0 ? 1 : -1)];
  }
  // We're above/below — go left or right
  return [targetPos[0] + (dx >= 0 ? 1 : -1), targetPos[1]];
}
