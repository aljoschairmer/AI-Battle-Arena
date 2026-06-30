import type { ClientAction } from "../types/protocol";
import type { Directive, EnginePolicy } from "../types/internal";
import { DEFAULT_DIRECTIVE, DEFAULT_POLICY } from "../types/internal";
import { dist } from "../shared/geometry";
import type { GameState } from "./gameState";
import { combatBehavior, gravityWellBehavior } from "./behaviors/combat";
import { idle, placeMine } from "./behaviors/context";
import { defaultReposition, grabPickup, positionForCombat } from "./behaviors/movement";
import { selectTarget } from "./behaviors/targeting";
import { emergencyDodge, retreatAndHeal, survivalBehavior } from "./behaviors/survival";

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

  onRoundStart(): void {
    this.minesPlacedThisRound = 0;
    this.lastMineTick = -1000;
  }

  decide(gs: GameState): ClientAction {
    const self = gs.self;
    const tick = gs.tick;

    // 1. Can't act.
    if (!self || !self.is_alive || gs.isRespawning) return idle(tick);
    if (self.stun_ticks > 0) return idle(tick);

    const ctx = { gs, directive: this.directive, policy: this.policy, tick };

    // 2. Environmental survival (outside zone / on hazard).
    const survive = survivalBehavior(ctx);
    if (survive) return survive;

    // 3. Reactive dodge.
    const dodgeAction = emergencyDodge(ctx);
    if (dodgeAction) return dodgeAction;

    // 4. Retreat / heal.
    const retreat = retreatAndHeal(ctx);
    if (retreat) {
      // 5. Mine the path behind us while fleeing — but ONLY if we're actually
      //    moving away (retreating), not if we're cornered in place.
      const mine = this.maybeDropMine(gs, true);
      if (mine) return mine;
      return retreat;
    }

    // 6. Gravity well on enemy clusters (staff/grapple weapons, opportunistic).
    const gw = gravityWellBehavior(ctx);
    if (gw) return gw;

    // 7. Engage the best target.
    const target = selectTarget(ctx);
    if (target) {
      const combat = combatBehavior(ctx, target);
      if (combat) return combat;
      return positionForCombat(ctx, target);
    }

    // 8. Opportunistic loot.
    const loot = grabPickup(ctx);
    if (loot) return loot;

    // 9. Hold good ground.
    return defaultReposition(ctx);
  }

  /**
   * Place a mine only when:
   * - An enemy is right behind us (≤2.2 tiles)
   * - We have charges remaining and the cooldown has elapsed
   * - retreatingNow is true (we're actively kiting, not cornered)
   *
   * Cornered mine placement wastes all 3 charges in one spot — avoid it.
   */
  private maybeDropMine(gs: GameState, retreatingNow: boolean): ClientAction | null {
    if (!retreatingNow) return null;
    if (!this.policy.mineWhenChased) return null;
    const self = gs.self;
    if (!self) return null;
    if (this.minesPlacedThisRound >= 6) return null;
    if (gs.tick - this.lastMineTick < this.policy.mineCooldownTicks) return null;

    const me = gs.position;
    const chaser = gs.enemies().find((e) => dist(me, e.position) <= this.policy.mineChaseRange);
    if (!chaser) return null;

    this.minesPlacedThisRound += 1;
    this.lastMineTick = gs.tick;
    return placeMine(gs.tick);
  }
}
