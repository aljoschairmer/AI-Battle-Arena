import type { ClientAction, NearbyBot } from "../../types/protocol";
import { chebyshev, dist, stepAwayFrom } from "../../shared/geometry";
import { profileFor } from "../weapons";
import { type DecisionContext, attack, attackAt, grappleTarget, grappleTo, gravityWell, move, shove } from "./context";
import { flankingPosition } from "./movement";
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

  // --- Universal: interrupt an adjacent enemy's visible windup with a shove ---
  // A charged bow shot is the biggest single hit in the game and the enemy
  // telegraphs it (charged_shot_ready / bow_charge_level). Shove's 2-tick stun
  // + knockback denies it outright. The preemptive-dodge survival rung usually
  // claims charged threats first, but its 30-tick dodge cooldown leaves
  // frequent windows where this is the only counter — before this branch the
  // engine's ONLY reaction to a windup was to move away. Skip when one normal
  // hit kills them anyway (a kill beats an interrupt).
  if (
    ctx.policy.shoveInterruptCharged &&
    d <= 1.5 &&
    gs.shoveReady(tick) &&
    target.has_los &&
    (target.charged_shot_ready || target.bow_charge_level >= 2) &&
    target.hp > profile.damage * (gs.selfCombat?.attackMult ?? 1)
  ) {
    return shove(tick, target.bot_id);
  }

  // --- Spear: never charge a braced enemy — wait them out (Tuner-toggleable) ---
  if (ctx.policy.spearBraceWait && self.weapon === "spear" && target.brace_ready && d <= range + 1) {
    // Don't attack into a brace — shove to disrupt if adjacent (respecting the
    // spec's 1.5s shove cooldown; a shove inside it is rejected server-side).
    if (d <= 1.5 && !self.weapon_ready && gs.shoveReady(tick)) {
      return shove(tick, target.bot_id);
    }
    // HOLD the spacing ourselves. Returning null here does NOT mean "wait":
    // the cascade guarantees positionForCombat claims the tick next, and its
    // melee branch walks straight INTO the braced enemy — the exact thing
    // this branch exists to avoid (pass-2 audit C3). Step down the threat
    // gradient (or plain away) until the brace drops.
    const holdStep = gs.threatField().safestStep(me, (c, r) => gs.isSafeStep(c, r), true);
    if (holdStep) return move(tick, holdStep);
    const back = stepAwayFrom(me, target.position);
    if (gs.isSafeStep(me[0] + back[0], me[1] + back[1])) return move(tick, back);
    return null; // truly boxed in — let the movement layer pick something
  }

  if (inRange) {
    if (self.weapon_ready) {
      // Mid-dodge targets are invulnerable for the dash's 3 invuln ticks — any
      // attack committed now lands nothing (demo-bot targeting skips dodging
      // bots for exactly this reason). Hold the shot: fall through to the
      // movement layer's strafe and swing next tick when they're hittable.
      if (target.is_dodging) return null;

      // Bow: fire charged shot whenever ready (Tuner can disable to fire faster/uncharged).
      let charged = profile.usesCharge && self.charged_shot_ready && ctx.policy.bowAlwaysCharge;
      // Smart-charge timing (demo-bot source read): enemies see our
      // charged_shot_ready flag and sidestep the telegraphed shot — but only
      // when they can't land their own hit this tick AND their dodge is off
      // cooldown ("trading beats juking" in their code). If a sidestep is
      // likely, fire UNCHARGED instead: no telegraph, and the reset flag stops
      // their pre-dodge loop. Spend the charge when they're forced to trade or
      // we've seen their dodge inside its 30-tick cooldown.
      if (charged && ctx.policy.bowSmartCharge) {
        const targetRange = target.attack_range || profileFor(target.weapon).baseRange;
        const forcedToTrade = target.can_attack && d <= targetRange + 0.5;
        if (!forcedToTrade && gs.enemyDodgeReady(target.bot_id)) charged = false;
      }

      // Staff: if we can hit multiple enemies, try gravity well first to cluster them
      if (self.weapon === "staff") {
        const gwAction = tryGravityWell(ctx);
        if (gwAction) return gwAction;
        // Place the delayed AoE/burn field on the enemy cluster centroid (to catch
        // several bots) or — since the field is delayed — where this target is
        // heading rather than where it stands now (target leading).
        let aoe = enemyCluster(ctx, 2) ?? gs.predictEnemyPos(target, ctx.policy.leadTicks);
        // AoE is indiscriminate: never drop the burn field on a coalition ally.
        if (ctx.policy.friendlySplashGuard && gs.allyNear(aoe, 1)) {
          aoe = target.position;
          if (gs.allyNear(aoe, 1)) {
            const spacing = gs.threatField().safestStep(me, (c, r) => gs.isSafeStep(c, r), true);
            return spacing ? move(tick, spacing) : null;
          }
        }
        return attackAt(tick, target.bot_id, aoe);
      }

      // Sword cleave clips every adjacent bot indiscriminately — never swing
      // with a coalition ally in the arc (attacker-adjacent) or hugging the
      // target. Four live teammate kills in the pass-3 prod fleet, ALL by the
      // sword slots, forced this guard: targeting filters can't stop
      // server-side splash. Step to spacing instead; the swing comes next
      // tick from a clean angle.
      if (
        ctx.policy.friendlySplashGuard &&
        self.weapon === "sword" &&
        (gs.allyNear(me, 1.5) || gs.allyNear(target.position, 1))
      ) {
        const spacing = gs.threatField().safestStep(me, (c, r) => gs.isSafeStep(c, r), true);
        return spacing ? move(tick, spacing) : null;
      }

      // Shield: bash disrupted targets for bonus damage
      if (self.weapon === "shield" && target.recently_disrupted_ticks > 0) {
        return attack(tick, target.bot_id, false);
      }

      // Daggers: strongly prefer hitting from the rear. Only defer to finish
      // an ALREADY-nearly-complete flank (one step from the facing-derived
      // behind tile) — and only for a BOUNDED number of consecutive ticks.
      // Both constraints are load-bearing: the behind tile moves when the
      // target turns (and the old approach-angle heuristic moved it whenever
      // WE stepped), so an unbounded defer chased a moving goalpost forever —
      // measured as 0 attack actions across entire daggers rounds
      // (docs/audit/pass2-phase2-observations.md). Past the streak cap we
      // commit to head-on attacks until the situation changes.
      if (ctx.policy.daggerFlank && self.weapon === "daggers" && !target.rear_exposed) {
        const behind = flankingPosition(me, target.position, target.facing);
        if (behind && chebyshev(me, behind) === 1 && gs.isPassable(behind[0], behind[1])) {
          if (gs.noteFlankDefer(tick) <= ctx.policy.flankMaxDeferTicks) {
            return null; // let positionForCombat take the final step
          }
        }
      }

      // Never shoot through a teammate: projectiles may hit the first bot in
      // the path (one live teammate kill by a bow slot). Step for a clean lane
      // instead; the shot comes next tick. Grapple's in-range attack is a
      // slam that can scatter — an ally near the target blocks it too.
      if (
        ctx.policy.friendlySplashGuard &&
        profile.ranged &&
        !profile.aoe &&
        (gs.allyInFireLane(target.position) || (self.weapon === "grapple" && gs.allyNear(target.position, 2)))
      ) {
        const spacing = gs.threatField().safestStep(me, (c, r) => gs.isSafeStep(c, r), true);
        return spacing ? move(tick, spacing) : null;
      }

      return attack(tick, target.bot_id, charged);
    }

    // Weapon on cooldown: use the tick productively. Shove options respect the
    // spec's 1.5s shove cooldown (self-tracked; the server never echoes it):
    // pre-fix this branch re-issued shove EVERY tick of the weapon cooldown
    // window, and every rejected shove was a tick spent standing point-blank
    // instead of taking the threat-aware step below (pass-2 audit C2).
    if (d <= 1.5) {
      if (gs.shoveReady(tick)) {
        // Shove into a wall for bonus knockback/stun
        if (target.near_impact_surface || directive.posture === "aggressive") {
          return shove(tick, target.bot_id);
        }
        // Shield bash on disrupted target even off cooldown
        if (self.weapon === "shield" && target.recently_disrupted_ticks > 0) {
          return shove(tick, target.bot_id);
        }
      }
      // Not aggressive: step away while cooling rather than eat the enemy's
      // next swing point-blank. Threat-field-aware (accounts for every nearby
      // enemy + zone + hazards, not just this one target) so cooling down
      // doesn't step out of this target's range and straight into another's —
      // mirrors the pattern survival.ts already uses for the same situation.
      const fieldStep = gs.threatField().safestStep(gs.position, (c, r) => gs.isSafeStep(c, r), true);
      if (fieldStep) return move(tick, fieldStep);
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

  // A grapple yank drags the target's BODY along the line to us — an ally on
  // that path gets slammed; the slam can also scatter beyond the line, so an
  // ally simply NEAR the target blocks the pull too (grapple slots kept
  // producing teammate kills after the lane-only guard).
  const pullLaneClear =
    !ctx.policy.friendlySplashGuard ||
    (!gs.allyInFireLane(target.position) && !gs.allyNear(target.position, 2));

  // Grapple weapon: use position-grapple to anchor self to walls when kiting ranged
  if (self.weapon === "grapple" && self.grapple_charges > 0 && self.grapple_cooldown <= 0) {
    // Primary: pull target toward us
    if (d <= 12 && target.has_los && pullLaneClear) {
      return grappleTarget(tick, target.bot_id);
    }
  }

  // Universal grapple-to-target for melee weapons: close the gap (LLM-tunable threshold).
  if (!profile.ranged && self.grapple_charges > 0 && self.grapple_cooldown <= 0) {
    if (d > range + ctx.policy.grappleCloseMinGap && d <= 12 && target.has_los && pullLaneClear) {
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
 * - We hold a COLLECTED gravity-well charge (spec: use_gravity_well needs a
 *   charge from a collected gravity_well pickup; without one it's rejected)
 * - There are 2+ enemies clustered within fog radius
 * Returns the action or null.
 *
 * The believed charge count is tracked by GameState from our own issued
 * actions (use_item on a gravity pickup = +1, use_gravity_well = -1). The
 * previous gate — "a gravity_well pickup entity is visible on the ground" —
 * was wrong in both directions (pass-2 audit C1): it cast with no charge
 * (rejected, and at priority 6 the spam preempted combat), and after actually
 * collecting the pickup the entity disappeared so a real charge could never
 * be spent.
 */
function tryGravityWell(ctx: DecisionContext): ClientAction | null {
  if (!ctx.policy.staffGravityWell) return null;
  const { gs, tick } = ctx;
  if (gs.gravityCharges() <= 0) return null;

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
