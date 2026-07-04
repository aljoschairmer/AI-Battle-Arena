import type { ClientAction, GridVec } from "../types/protocol";
import type { CoopRole, Directive, EnginePolicy } from "../types/internal";
import { DEFAULT_DIRECTIVE, DEFAULT_POLICY } from "../types/internal";
import { dist } from "../shared/geometry";
import type { GameState } from "./gameState";
import { combatBehavior, gravityWellBehavior } from "./behaviors/combat";
import { tradeAdvantage } from "./combatMath";
import { idle, isEndgame, placeMine } from "./behaviors/context";
import { defaultReposition, grabPickup, positionForCombat } from "./behaviors/movement";
import { selectTarget } from "./behaviors/targeting";
import {
  emergencyDodge,
  resolvePendingDodge,
  retreatAndHeal,
  survivalBehavior,
  tacticalDisengage,
} from "./behaviors/survival";
import { telemetry, type PriorityName } from "./telemetryLog";

/**
 * The reactive controller: deterministic, allocation-light, runs every tick in
 * well under a millisecond. Composes behaviour modules in strict priority order.
 * The LLM Brain never touches this path — it only swaps the `directive` it reads.
 *
 * Priority (highest first):
 *   1. Can't act (dead / stunned / respawning)     -> idle
 *   2. Survive the environment (zone / hazard)      -> reposition to safety
 *   3. Emergency dodge incoming hit                 -> spend dodge
 *   4. Retreat & heal when low / told to            -> kite + heal
 *   5. Drop a mine while being chased (retreating)  -> place_mine
 *   6. Gravity well on clusters (staff/grapple)     -> use_gravity_well
 *   7. Fight the chosen target (attack/special)     -> or position for it
 *   8. Grab a valuable nearby pickup               -> use_item / move
 *   9. Default: pre-position for zone / capture pad -> move_to
 */
export class Controller {
  private directive: Directive = { ...DEFAULT_DIRECTIVE };
  private policy: EnginePolicy = { ...DEFAULT_POLICY };
  private coopFocus: string | null = null;
  private coopRole: CoopRole | null = null;
  private minesPlacedThisRound = 0;
  private lastMineTick = -1000;

  setDirective(d: Directive): void {
    this.directive = d;
  }

  getDirective(): Directive {
    return this.directive;
  }

  /** Apply a live tuning policy from the LLM Tuner (no restart required). */
  setPolicy(p: EnginePolicy): void {
    this.policy = p;
  }

  getPolicy(): EnginePolicy {
    return this.policy;
  }

  /** Coalition focus-fire target (used when the Brain hasn't pinned one). */
  setCoopFocus(id: string | null): void {
    this.coopFocus = id;
  }

  /** Squad role assigned by the Coordinator brain (hold/flank/support), or null. */
  setCoopRole(role: CoopRole | null): void {
    this.coopRole = role;
  }

  onRoundStart(): void {
    this.minesPlacedThisRound = 0;
    this.lastMineTick = -1000;
  }

  /**
   * Single choke point wrapping the priority cascade: every issued action
   * passes through here exactly once, giving (a) telemetry a complete record
   * of what was actually sent (action-economy analysis: shove cooldown
   * violations, gravity-well spam — see pass-2 audit) and (b) GameState a
   * place to track self-inflicted action economy the server doesn't echo
   * (shove cooldown, believed gravity-well charges).
   */
  decide(gs: GameState): ClientAction {
    const action = this.decideInner(gs);
    gs.noteIssuedAction(action);
    telemetry.actionIssued({ tick: gs.tick, action: action.action });
    return action;
  }

  private decideInner(gs: GameState): ClientAction {
    const self = gs.self;
    const tick = gs.tick;

    // Telemetry only (Phase 2 audit): resolve any dodge initiated last tick
    // now that this tick's damage is known. Deliberately BEFORE the can't-act
    // guard below — see resolvePendingDodge's doc for why.
    resolvePendingDodge(gs, tick);

    // 1. Can't act.
    if (!self || !self.is_alive || gs.isRespawning) {
      telemetry.tickDecision({
        tick,
        priority: "cant_act",
        fellThrough: [],
        reason: !self ? "no_self" : !self.is_alive ? "dead" : "respawning",
        hp: self?.hp ?? 0,
        maxHp: self?.max_hp ?? 0,
        posX: gs.position[0],
        posY: gs.position[1],
      });
      return idle(tick);
    }
    if (self.stun_ticks > 0) {
      telemetry.tickDecision({
        tick,
        priority: "cant_act",
        fellThrough: [],
        reason: "stunned",
        hp: self.hp,
        maxHp: self.max_hp,
        posX: gs.position[0],
        posY: gs.position[1],
      });
      return idle(tick);
    }

    let directive = this.resolveDirective();
    // We ARE the bounty target: the server broadcasts our live position to
    // every bot in the arena (fog-exempt beacon), so expect third parties and
    // play it safer. Engine-side (not just a Brain prompt hint) so a
    // deterministic-only deployment reacts too; the Brain's directive still
    // layers on top of this baseline shift.
    if (gs.isBountyTargetSelf()) {
      directive = {
        ...directive,
        hpRetreatFraction: Math.min(1, directive.hpRetreatFraction + 0.08),
        aggression: Math.max(0, directive.aggression - 0.1),
      };
    }
    const ctx = { gs, directive, policy: this.policy, tick };
    const fellThrough: PriorityName[] = [];
    const logTick = (priority: PriorityName, reason: string): void => {
      telemetry.tickDecision({
        tick,
        priority,
        fellThrough: [...fellThrough],
        reason,
        hp: self.hp,
        maxHp: self.max_hp,
        posX: gs.position[0],
        posY: gs.position[1],
      });
    };

    // 2. Environmental survival (outside zone / on hazard). Can also return a
    // dodge (survivalBehavior's narrow imminent-hit exception) — attribute
    // that to emergency_dodge in telemetry, not survive_zone_hazards, so the
    // priority-claim distribution reflects what actually happened.
    const survive = survivalBehavior(ctx);
    if (survive) {
      if (survive.action === "dodge") {
        logTick("emergency_dodge", "imminent_hit_preempts_survival");
      } else {
        logTick(
          "survive_zone_hazards",
          !self.in_safe_zone
            ? "outside_zone"
            : self.zone_target_radius < self.zone_radius
              ? "zone_edge_drift"
              : gs.hasNegativeEffect()
                ? "burning"
                : "hazard_adjacent",
        );
      }
      return survive;
    }
    fellThrough.push("survive_zone_hazards");

    // 3. Reactive dodge.
    const dodgeAction = emergencyDodge(ctx);
    if (dodgeAction) {
      logTick("emergency_dodge", (self.hits_received ?? []).length > 0 ? "just_hit" : "proactive_threat");
      return dodgeAction;
    }
    fellThrough.push("emergency_dodge");

    // 4. Retreat / heal.
    const retreat = retreatAndHeal(ctx);
    if (retreat) {
      // 5. Mine the path behind us while fleeing — but ONLY if we're actually
      //    moving away (retreating), not if we're cornered in place.
      const mine = this.maybeDropMine(gs, true, retreat);
      if (mine) {
        logTick("retreat_heal_mine", "mine_while_retreating");
        return mine;
      }
      logTick(
        "retreat_heal_mine",
        gs.hpFraction() < ctx.directive.hpRetreatFraction ? "hp<retreatFraction" : "posture=retreat",
      );
      return retreat;
    }
    fellThrough.push("retreat_heal_mine");

    // 6. Gravity well on enemy clusters (staff/grapple weapons, opportunistic).
    const gw = gravityWellBehavior(ctx);
    if (gw) {
      logTick("gravity_well", "cluster_opportunity");
      return gw;
    }
    fellThrough.push("gravity_well");

    // 7. Engage the best target — unless the trade looks lost and we aren't
    //    pinned to it, in which case disengage toward safer ground.
    const target = selectTarget(ctx);
    if (target) {
      // Only bail from a bad trade when we're actually HURT — while healthy we
      // commit to fights (a bot that disengages every marginal trade reads as
      // passive and hands over ground + damage uptime). A pinned target is never
      // abandoned.
      const forced = this.directive.primaryTargetId === target.bot_id;
      // Computed unconditionally (not just inside the hp-gated check below) so
      // Phase 2/3 telemetry can see what trade math predicted for EVERY
      // engagement, not only the ones already hp-gated into re-checking it.
      const advantage = tradeAdvantage(ctx, target);
      // Endgame with company: in a tiny zone with 2+ enemies around, a lost
      // fight is terminal (nowhere to retreat, the survivor cleans us up), so
      // the trade gate applies even at full HP and demands extra margin. A
      // final 1v1 keeps the normal commit-while-healthy behavior — there,
      // passivity just splits the zone damage.
      const endgameCaution = isEndgame(ctx) && gs.enemies().length >= 2;
      const wouldBail =
        !forced &&
        (gs.hpFraction() < ctx.policy.disengageHpThreshold || endgameCaution) &&
        advantage < ctx.policy.minTradeAdvantage + (endgameCaution ? ctx.policy.endgameTradeCaution : 0);
      let bail: ClientAction | null = null;
      if (wouldBail) {
        bail = tacticalDisengage(ctx);
      }
      telemetry.tradeEvaluated({
        tick,
        targetId: target.bot_id,
        predictedAdvantage: advantage,
        decision: bail ? "disengage" : wouldBail ? "hold" : "engage",
        // Raw HP, not derived.ts's defense-adjusted effectiveHp — tradeAdvantage()
        // itself only ever compares raw hp/DPS (Phase 1 finding), so this reports
        // what actually drove the decision rather than a number the engine never used.
        ourEffectiveHp: self.hp,
        theirEffectiveHp: target.hp,
        nearbyEnemyCount: gs.enemies().filter((e) => e.bot_id !== target.bot_id && dist(gs.position, e.position) <= 5)
          .length,
      });
      if (bail) {
        logTick("engage_target", "disengage_bad_trade");
        return bail;
      }
      const combat = combatBehavior(ctx, target);
      if (combat) {
        logTick("engage_target", forced ? "forced_target" : "best_scored_target");
        return combat;
      }
      logTick("engage_target", "positioning_for_combat");
      return positionForCombat(ctx, target);
    }
    fellThrough.push("engage_target");

    // 8. Opportunistic loot.
    const loot = grabPickup(ctx);
    if (loot) {
      logTick("grab_pickups", "pickup_in_budget");
      return loot;
    }
    fellThrough.push("grab_pickups");

    // 9. Hold good ground.
    logTick("hold_ground_zone", "no_target_no_pickup");
    return defaultReposition(ctx);
  }

  /**
   * Resolve the posture/aggression the behaviours actually use, combining the
   * Tuner's slow learned BASELINE (policy) with the Tactician's fast tactical
   * intent (directive):
   *   - aggression = policy baseline + the directive's deviation from default,
   *     so the Tactician nudges around whatever the Tuner has learned.
   *   - posture = the live tactical posture when the brain set one, else the
   *     Tuner's baseline posture (which also drives the deterministic-only bot).
   */
  private resolveDirective(): Directive {
    const d = this.directive;
    const p = this.policy;
    const brainSet = d.source === "strategist" || d.source === "tactician";
    let aggression = Math.max(
      0,
      Math.min(1, p.aggression + (d.aggression - DEFAULT_DIRECTIVE.aggression)),
    );
    let hpRetreatFraction = d.hpRetreatFraction;

    // Squad role from the Coordinator brain — basic fireteam doctrine: the
    // frontline (hold) fights longer, ranged support (support) peels earlier,
    // the flanker (flank) presses harder to exploit the opening it's chasing.
    if (this.coopRole === "hold") {
      hpRetreatFraction = Math.max(0, hpRetreatFraction - 0.08);
    } else if (this.coopRole === "support") {
      aggression = Math.max(0, aggression - 0.1);
      hpRetreatFraction = Math.min(1, hpRetreatFraction + 0.1);
    } else if (this.coopRole === "flank") {
      aggression = Math.min(1, aggression + 0.1);
    }

    // Fall back to the coalition's focus-fire target when the Brain hasn't
    // pinned one (selectTarget still only commits if it's visible + worthwhile).
    const primaryTargetId = d.primaryTargetId ?? this.coopFocus;
    return {
      ...d,
      aggression,
      hpRetreatFraction,
      posture: brainSet ? d.posture : p.posture,
      primaryTargetId,
    };
  }

  /**
   * Place a mine only when:
   * - An enemy is right behind us (≤ mineChaseRange) AND roughly on the path
   *   we're retreating along, not just anywhere in range — a chaser to the
   *   side or ahead of us won't walk over a mine dropped at our current tile.
   * - We have charges remaining and the cooldown has elapsed
   * - retreatingNow is true (we're actively kiting, not cornered)
   *
   * Cornered mine placement wastes all 3 charges in one spot — avoid it.
   */
  private maybeDropMine(gs: GameState, retreatingNow: boolean, retreatAction: ClientAction | null): ClientAction | null {
    if (!retreatingNow) return null;
    if (!this.policy.mineWhenChased) return null;
    const self = gs.self;
    if (!self) return null;
    // Canonical cap from /api/v1/bot-setup: "Max 3 per bot" — placing more just
    // wastes the action (server rejects it). The server echoes the authoritative
    // count as your_state.mine_count (pass-4 audit): prefer it — the local
    // counter misses rejected placements and desyncs across mid-round reconnects.
    if (gs.minesPlaced(this.minesPlacedThisRound) >= 3) return null;
    if (gs.tick - this.lastMineTick < this.policy.mineCooldownTicks) return null;
    // Never seed a shared retreat corridor: an ally close behind us follows
    // the same escape lines, and a mine placed <500ms before they cross it is
    // invisible to them even with the coalition broadcast (reports are
    // tick-batched). Mines while fleeing in a pack aren't worth a teammate.
    if (this.policy.friendlySplashGuard && gs.allyNear(gs.position, 6)) return null;

    const me = gs.position;
    const retreatVector = maybeRetreatVector(retreatAction, me);
    const chaser = gs.enemies().find((e) => {
      if (dist(me, e.position) > this.policy.mineChaseRange) return false;
      if (!retreatVector) return true; // can't tell direction (e.g. server pathfind target) — proximity only
      const toChaser: GridVec = [e.position[0] - me[0], e.position[1] - me[1]];
      // Negative dot product = roughly opposite our travel direction = behind us.
      return retreatVector[0] * toChaser[0] + retreatVector[1] * toChaser[1] < 0;
    });
    if (!chaser) return null;

    this.minesPlacedThisRound += 1;
    this.lastMineTick = gs.tick;
    return placeMine(gs.tick);
  }
}

/** Direction of travel implied by a retreat action, or null if it can't be read (e.g. idle/attack). */
function maybeRetreatVector(action: ClientAction | null, me: [number, number]): GridVec | null {
  if (!action) return null;
  if (action.action === "move") return action.direction;
  if (action.action === "move_to") {
    const dx = action.target_position[0] - me[0];
    const dy = action.target_position[1] - me[1];
    return dx === 0 && dy === 0 ? null : [dx, dy];
  }
  return null;
}
