import type { ClientAction, GridVec, NearbyBot, NearbyPickup } from "../../types/protocol";
import {
  dist,
  perpendicularStep,
  stepAwayFrom,
  toUnitStep,
} from "../../shared/geometry";
import { profileFor } from "../weapons";
import { type DecisionContext, move, moveTo } from "./context";

/**
 * Positioning relative to a target. Melee bots close in; ranged bots hold near
 * their preferred range and kite/strafe to stay alive while dealing damage.
 */
export function positionForCombat(ctx: DecisionContext, target: NearbyBot): ClientAction {
  const { gs, tick } = ctx;
  const self = gs.self!;
  const me = gs.position;
  const d = dist(me, target.position);
  const profile = profileFor(self.weapon);

  if (!profile.ranged) {
    // Melee: walk straight at them via the server's pathfinder.
    return moveTo(tick, target.position);
  }

  const range = gs.effectiveAttackRange();
  const preferred = Math.min(profile.preferredRange, range);

  // Too close — back off to open the gap (kite).
  if (d < preferred - 0.5) {
    const away = stepAwayFrom(me, target.position);
    const step = pickSafe(ctx, [away, perpendicularStep(me, target.position)]);
    if (step) return move(tick, step);
  }

  // Too far — advance to get into firing range.
  if (d > range + 0.25) {
    return moveTo(tick, target.position);
  }

  // In the sweet spot — strafe perpendicular to be a harder target while we cool
  // down, keeping line of sight.
  const perp = perpendicularStep(me, target.position);
  const step = pickSafe(ctx, [perp, [-perp[0], -perp[1]] as GridVec]);
  if (step) return move(tick, step);

  // Nowhere safe to strafe — hold position aimed at the target.
  return moveTo(tick, target.position);
}

const PICKUP_VALUE: Record<string, number> = {
  health: 1.0,
  hp: 1.0,
  heal: 1.0,
  overdrive: 0.95,
  damage: 0.85,
  attack: 0.85,
  shield: 0.8,
  speed: 0.7,
  grapple: 0.65,
  bounty: 0.6,
  cooldown: 0.6,
  relay: 0.4,
  hazard: 0.3,
};

function pickupScore(type: string): number {
  const t = type.toLowerCase();
  for (const [key, val] of Object.entries(PICKUP_VALUE)) {
    if (t.includes(key)) return val;
  }
  return 0.35;
}

/**
 * Opportunistically grab a nearby, valuable, safe pickup when we're not busy
 * fighting. Aggression in the directive shrinks how far we'll detour for loot.
 */
export function grabPickup(ctx: DecisionContext): ClientAction | null {
  const { gs, tick, directive } = ctx;
  const me = gs.position;
  const pickups = gs.pickups();
  if (pickups.length === 0) return null;

  const maxDetour = 6 - directive.aggression * 3; // 3..6 tiles
  let best: NearbyPickup | null = null;
  let bestScore = -Infinity;

  for (const p of pickups) {
    const d = dist(me, p.position);
    if (d > maxDetour) continue;
    if (enemyControls(gs.enemies(), p.position)) continue;
    const score = pickupScore(p.pickup_type) * 10 - d;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  if (!best) return null;

  // Standing on it — collect; otherwise path to it.
  if (dist(me, best.position) <= 0.75) {
    return { type: "action", tick, action: "use_item", item_id: best.pickup_id };
  }
  return moveTo(tick, best.position);
}

/**
 * Nothing to fight and nothing to grab: pre-position toward where the zone is
 * heading so we control good ground when it shrinks.
 */
export function defaultReposition(ctx: DecisionContext): ClientAction {
  const { gs, tick } = ctx;
  const self = gs.self!;
  const target =
    self.zone_target_radius < self.zone_radius ? self.zone_target_center : self.zone_center;
  return moveTo(tick, target);
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
