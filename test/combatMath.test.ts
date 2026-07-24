import { describe, expect, it } from "vitest";
import { enemyDps, shouldEngage, tradeAdvantage } from "../src/engine/combatMath";
import type { DecisionContext } from "../src/engine/behaviors/context";
import { DEFAULT_DIRECTIVE, DEFAULT_POLICY } from "../src/types/internal";
import type { GameState } from "../src/engine/gameState";
import { enemy, freshGameState, self, tickFrom } from "./helpers";

function ctxOf(gs: GameState): DecisionContext {
  return { gs, directive: DEFAULT_DIRECTIVE, policy: DEFAULT_POLICY, tick: gs.tick };
}

describe("enemyDps", () => {
  it("estimates positive DPS for every weapon we can face", () => {
    for (const w of ["sword", "bow", "daggers", "shield", "spear", "staff", "grapple"] as const) {
      expect(enemyDps(enemy({ weapon: w }))).toBeGreaterThan(0);
    }
  });
});

describe("tradeAdvantage", () => {
  it("is bounded in (-1, 1)", () => {
    const gs = freshGameState();
    const e = enemy();
    gs.applyTick(tickFrom(self(), [e]));
    const adv = tradeAdvantage(ctxOf(gs), e);
    expect(adv).toBeGreaterThan(-1);
    expect(adv).toBeLessThan(1);
  });

  it("reads a near-dead enemy vs a healthy self as favorable", () => {
    const gs = freshGameState();
    const weak = enemy({ hp: 5 });
    gs.applyTick(tickFrom(self({ hp: 160 }), [weak]));
    expect(tradeAdvantage(ctxOf(gs), weak)).toBeGreaterThan(0);
  });

  it("reads a near-dead self vs a healthy enemy as unfavorable", () => {
    const gs = freshGameState();
    const strong = enemy({ hp: 160 });
    gs.applyTick(tickFrom(self({ hp: 5 }), [strong]));
    expect(tradeAdvantage(ctxOf(gs), strong)).toBeLessThan(0);
  });

  it("a second in-range attacker makes the same 1v1 strictly worse (gank math)", () => {
    const target = enemy({ bot_id: "t", position: [51, 50], hp: 80 });
    const solo = freshGameState();
    solo.applyTick(tickFrom(self({ hp: 80 }), [target]));
    const advSolo = tradeAdvantage(ctxOf(solo), target);

    const ganked = freshGameState();
    ganked.applyTick(
      tickFrom(self({ hp: 80 }), [target, enemy({ bot_id: "ganker", position: [49, 50], can_attack: true })]),
    );
    const advGanked = tradeAdvantage(ctxOf(ganked), target);
    expect(advGanked).toBeLessThan(advSolo);
  });

  it("returns 0 when we have no self state", () => {
    const gs = freshGameState();
    expect(tradeAdvantage(ctxOf(gs), enemy())).toBe(0);
  });
});

describe("shouldEngage", () => {
  it("applies the policy's minTradeAdvantage threshold", () => {
    const gs = freshGameState();
    const weak = enemy({ hp: 5 });
    gs.applyTick(tickFrom(self({ hp: 160 }), [weak]));
    const adv = tradeAdvantage(ctxOf(gs), weak);
    expect(shouldEngage(ctxOf(gs), weak)).toBe(adv >= DEFAULT_POLICY.minTradeAdvantage);
    // An unreachable threshold refuses even the best trade.
    const strict: DecisionContext = { gs, directive: DEFAULT_DIRECTIVE, policy: { ...DEFAULT_POLICY, minTradeAdvantage: 0.99 }, tick: gs.tick };
    expect(shouldEngage(strict, weak)).toBe(false);
  });
});
