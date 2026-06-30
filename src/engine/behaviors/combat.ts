import type { ClientAction, NearbyBot } from "../../types/protocol";
import { dist } from "../../shared/geometry";
import { profileFor } from "../weapons";
import { type DecisionContext, attack, grappleTarget, shove } from "./context";

/**
 * Combat resolution against a chosen target. Decides whether to attack (and how),
 * or to use a universal special (grapple to close, shove for positioning) when
 * an attack isn't available this tick. Returns null when we're out of range and
 * should let the movement layer reposition.
 *
 * Universal specials (per arena rules, available to every bot regardless of
 * weapon): 2 grapple charges/round, up to 3 mines/round, and shove.
 */
export function combatBehavior(ctx: DecisionContext, target: NearbyBot): ClientAction | null {
  const { gs, tick, directive } = ctx;
  const self = gs.self;
  if (!self) return null;

  const me = gs.position;
  const d = dist(me, target.position);
  const range = gs.effectiveAttackRange();
  const profile = profileFor(self.weapon);

  const inRange = d <= range + 0.5;

  if (inRange) {
    if (self.weapon_ready) {
      // Bow: spend a charged shot at distance where the wind-up pays off.
      const charged = profile.usesCharge && self.charged_shot_ready && d >= 3;
      return attack(tick, target.bot_id, charged);
    }

    // Weapon on cooldown but enemy is adjacent: do something useful instead of
    // wasting the tick. Shove a target into a wall (bonus) or just to create
    // space / interrupt — but not when we're the defensive type holding ground.
    if (d <= 1.5 && (target.near_impact_surface || directive.posture === "aggressive")) {
      return shove(tick, target.bot_id);
    }
    return null; // let movement strafe while cooling down
  }

  // Out of melee range: close the gap with a grapple if it's a melee weapon,
  // we have charges, and the target is within grapple reach with line of sight.
  if (!profile.ranged && self.grapple_charges > 0 && self.grapple_cooldown <= 0) {
    if (d > range + 1.5 && d <= 12 && target.has_los) {
      return grappleTarget(tick, target.bot_id);
    }
  }

  return null;
}
