import type { ClientAction } from "../types/protocol";
import type { Directive } from "../types/internal";
import { DEFAULT_DIRECTIVE } from "../types/internal";
import { dist } from "../shared/geometry";
import type { GameState } from "./gameState";
import { combatBehavior } from "./behaviors/combat";
import { idle, placeMine } from "./behaviors/context";
import { defaultReposition, grabPickup, positionForCombat } from "./behaviors/movement";
import { selectTarget } from "./behaviors/targeting";
import { emergencyDodge, retreatAndHeal, survivalBehavior } from "./behaviors/survival";

/**
 * The reactive controller: deterministic, allocation-light, runs every tick in
 * well under a millisecond. It composes the behaviour modules in strict priority
 * order and is the ONLY thing in the loop that decides an action. The LLM Brain
 * never touches this path — it only swaps out the `directive` it reads.
 *
 * Priority (highest first):
 *   1. Can't act (dead / stunned)         -> idle
 *   2. Survive the environment (zone/haz)  -> reposition to safety
 *   3. Emergency dodge an incoming hit
 *   4. Retreat & heal when low / told to
 *   5. Drop a mine while being chased
 *   6. Fight the chosen target (attack/special) or position for it
 *   7. Grab a valuable nearby pickup
 *   8. Default: pre-position for the shrinking zone
 */
export class Controller {
  private directive: Directive = { ...DEFAULT_DIRECTIVE };
  private minesPlacedThisRound = 0;
  private lastMineTick = -1000;

  setDirective(d: Directive): void {
    this.directive = d;
  }

  getDirective(): Directive {
    return this.directive;
  }

  onRoundStart(): void {
    this.minesPlacedThisRound = 0;
    this.lastMineTick = -1000;
  }

  decide(gs: GameState): ClientAction {
    const self = gs.self;
    const tick = gs.tick;
    if (!self || !self.is_alive) return idle(tick);
    if (self.stun_ticks > 0) return idle(tick);

    const ctx = { gs, directive: this.directive, tick };

    // 2. Environmental survival (outside zone / on hazard).
    const survive = survivalBehavior(ctx);
    if (survive) return survive;

    // 3. Reactive dodge.
    const dodge = emergencyDodge(ctx);
    if (dodge) return dodge;

    // 4. Retreat / heal.
    const retreat = retreatAndHeal(ctx);
    if (retreat) {
      // 5. Mine the path behind us while fleeing.
      const mine = this.maybeDropMine(gs);
      if (mine) return mine;
      return retreat;
    }

    // 6. Engage the best target.
    const target = selectTarget(ctx);
    if (target) {
      const combat = combatBehavior(ctx, target);
      if (combat) return combat;
      return positionForCombat(ctx, target);
    }

    // 7. Opportunistic loot.
    const loot = grabPickup(ctx);
    if (loot) return loot;

    // 8. Hold good ground.
    return defaultReposition(ctx);
  }

  /**
   * Place a mine when an enemy is right on our heels and we still have charges.
   * Mines arm after ~1s, so this only pays off while actively kiting away.
   */
  private maybeDropMine(gs: GameState): ClientAction | null {
    const self = gs.self;
    if (!self) return null;
    if (this.minesPlacedThisRound >= 3) return null;
    if (gs.tick - this.lastMineTick < 30) return null;

    const me = gs.position;
    const chaser = gs.enemies().find((e) => dist(me, e.position) <= 2.2);
    if (!chaser) return null;

    this.minesPlacedThisRound += 1;
    this.lastMineTick = gs.tick;
    return placeMine(gs.tick);
  }
}
