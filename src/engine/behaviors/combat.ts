import type { ClientAction, NearbyBot } from "../../types/protocol";
import { dist, stepAwayFrom } from "../../shared/geometry";
import { profileFor } from "../weapons";
import { type DecisionContext, attack, attackAt, grappleTarget, grappleTo, gravityWell, move, shove } from "./context";
import { enemyCluster } from "./targeting";

/**
 * Combat resolution against a chosen target. Decides whether to attack (and how),
 * use weapon-specific specials, or employ universal specials (grapple/shove/gravity well).
 * Returns null when out of range — the movement layer repositions.
 *
 * Weapon-specific logic:
 *   bow:    fire charged shot when target is distant and charged_shot_ready
 *   daggers: prefer rear-exposed targets; reposition if target not rear-exposed
 *   spear:  never charge a braced enemy head-on; wait for their brace to expire
 *   shield: bash disrupted targets (recently_disrupted_ticks > 0)
 *   staff:  fire into enemy clusters; use gravity well to create clusters
 *   grapple: use charges to close gap or anchor on walls; grapple-to-position to escape hazards
 *
 * Universal specials (every weapon):
 *   shove: knock into walls (near_impact_surface bonus), stun for 2 ticks
 *   place_mine: handled in controller
 *   grapple charges: 2/round, close melee gap or reposition
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

  // --- Spear: never charge a braced enemy — wait them out ---
  if (self.weapon === "spear" && target.brace_ready && d <= range + 1) {
    // Don't attack into a brace — shove to disrupt if adjacent, otherwise wait
    if (d <= 1.5 && !self.weapon_ready) {
      return shove(tick, target.bot_id);
    }
    return null;
  }

  if (inRange) {
    if (self.weapon_ready) {
      // Bow: fire charged shot whenever ready — it always deals more damage.
      const charged = profile.usesCharge && self.charged_shot_ready;

      // Staff: if we can hit multiple enemies, try gravity well first to cluster them
      if (self.weapon === "staff") {
        const gwAction = tryGravityWell(ctx);
        if (gwAction) return gwAction;
        // Place the delayed AoE/burn field on the enemy cluster centroid (to catch
        // several bots) or — since the field is delayed — where this target is
        // heading rather than where it stands now (target leading).
        const aoe = enemyCluster(ctx, 2) ?? gs.predictEnemyPos(target, ctx.policy.leadTicks);
        return attackAt(tick, target.bot_id, aoe);
      }

      // Shield: bash disrupted targets for bonus damage
      if (self.weapon === "shield" && target.recently_disrupted_ticks > 0) {
        return attack(tick, target.bot_id, false);
      }

      // Daggers: strongly prefer hitting from the rear
      if (self.weapon === "daggers" && !target.rear_exposed && d <= 1.5) {
        // Reposition to flank — but still attack if it's the only option
        // (fallthrough to normal attack below)
      }

      return attack(tick, target.bot_id, charged);
    }

    // Weapon on cooldown: use the tick productively
    if (d <= 1.5) {
      // Shove into a wall for bonus knockback/stun
      if (target.near_impact_surface || directive.posture === "aggressive") {
        return shove(tick, target.bot_id);
      }
      // Shield bash on disrupted target even off cooldown
      if (self.weapon === "shield" && target.recently_disrupted_ticks > 0) {
        return shove(tick, target.bot_id);
      }
      // Not aggressive: step away while cooling rather than eat the enemy's
      // next swing point-blank. Wall-aware so we don't freeze in a corner.
      const away = gs.stepAwayFrom(target.position);
      const col = gs.position[0] + away[0];
      const row = gs.position[1] + away[1];
      if (gs.isSafeStep(col, row)) return move(tick, away);
    }

    return null; // let movement strafe while cooling down
  }

  // --- Out of range: close the gap ---

  // Staff: try gravity well to pull enemies into range before closing
  if (self.weapon === "staff") {
    const gwAction = tryGravityWell(ctx);
    if (gwAction) return gwAction;
  }

  // Grapple weapon: use position-grapple to anchor self to walls when kiting ranged
  if (self.weapon === "grapple" && self.grapple_charges > 0 && self.grapple_cooldown <= 0) {
    // Primary: pull target toward us
    if (d <= 12 && target.has_los) {
      return grappleTarget(tick, target.bot_id);
    }
  }

  // Universal grapple-to-target for melee weapons: close the gap (LLM-tunable threshold).
  if (!profile.ranged && self.grapple_charges > 0 && self.grapple_cooldown <= 0) {
    if (d > range + ctx.policy.grappleCloseMinGap && d <= 12 && target.has_los) {
      return grappleTarget(tick, target.bot_id);
    }
  }

  // Ranged weapon out of range: try grappling to a position halfway to target
  // to gain a better firing angle without rushing into melee
  if (profile.ranged && self.weapon !== "grapple" && self.grapple_charges > 0 && self.grapple_cooldown <= 0) {
    if (d > range + 2 && d <= 12) {
      // Grapple toward target but stop short of melee range
      const halfCol = Math.round((me[0] + target.position[0]) / 2);
      const halfRow = Math.round((me[1] + target.position[1]) / 2);
      if (gs.isPassable(halfCol, halfRow)) {
        return grappleTo(tick, [halfCol, halfRow]);
      }
    }
  }

  return null;
}

/**
 * Try to deploy a gravity well if:
 * - We have an active gravity well item (hazard_key_active acts as the trigger)
 * - There are 2+ enemies clustered within fog radius
 * Returns the action or null.
 *
 * Note: the server gives us gravity_well as a pickup item (use_item) or as a
 * direct action (use_gravity_well). We use the direct action targeting the
 * enemy cluster centroid.
 */
function tryGravityWell(ctx: DecisionContext): ClientAction | null {
  const { gs, tick } = ctx;
  // Only fire if we have the gravity well item active (indicated by a gravity_well pickup entity)
  const hasGravityWell = gs.entities.some(
    (e) => e.type === "pickup" && "pickup_type" in e && (e.pickup_type as string).includes("gravity"),
  );
  if (!hasGravityWell) return null;

  const cluster = enemyCluster(ctx, 4);
  if (!cluster) return null;

  const [cx, cy] = cluster;
  if (gs.isPassable(cx, cy)) {
    return gravityWell(tick, [cx, cy]);
  }
  return null;
}

/**
 * Opportunistic gravity well deployment: call this from the controller when
 * we're NOT in range of a target but there's a cluster to exploit.
 * Used by staff and grapple weapons specifically.
 */
export function gravityWellBehavior(ctx: DecisionContext): ClientAction | null {
  const { gs } = ctx;
  const self = gs.self;
  if (!self) return null;
  // Only staff and grapple users have tactical gravity well use cases
  if (self.weapon !== "staff" && self.weapon !== "grapple") return null;
  return tryGravityWell(ctx);
}
