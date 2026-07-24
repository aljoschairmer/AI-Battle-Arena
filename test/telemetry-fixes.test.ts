/**
 * Regression tests for the telemetry-integrity fixes: round-relative tick
 * accounting, cause-of-death classification, and knowledge-dump richness
 * comparison.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyCauseOfDeath, isEnvironmentKiller } from "../src/engine/outcomeLog";
import { isSourceRicher } from "../src/shared/knowledge";
import { freshGameState, self, tickFrom } from "./helpers";

describe("round-relative tick counter (ticksSurvived source)", () => {
  it("resets on round_start so the fallback increment cannot accumulate across rounds", () => {
    const gs = freshGameState();
    for (let t = 1; t <= 500; t++) gs.applyTick(tickFrom(self(), [], t));
    expect(gs.roundTick).toBeGreaterThanOrEqual(500);
    gs.applyRoundStart({
      type: "round_start",
      round_number: 2,
      round_modifier: "",
      round_modifier_label: "",
      position: [50, 50],
      bots_in_round: 8,
      all_positions: {},
      safe_zone: { center: [50, 50], radius: 40, target_center: [50, 50], target_radius: 9 },
    });
    gs.applyTick(tickFrom(self(), [], 501));
    expect(gs.roundTick).toBe(1);
  });

  it("resets on (re)connect so a mid-round join counts only ticks we were present", () => {
    const gs = freshGameState();
    // Session-global tick numbers in the hundreds of thousands (the exact
    // shape that produced 518k-tick "rounds" in the old telemetry).
    for (let t = 518_000; t <= 518_010; t++) gs.applyTick(tickFrom(self(), [], t));
    expect(gs.roundTick).toBeLessThanOrEqual(11);
  });

  it("prefers the server's round_tick when the frame carries one", () => {
    const gs = freshGameState();
    const msg = tickFrom(self(), [], 900);
    (msg as { round_tick?: number }).round_tick = 42;
    gs.applyTick(msg);
    expect(gs.roundTick).toBe(42);
  });
});

describe("killedBy / cause-of-death integrity", () => {
  it("flags explicit environment records and legacy all-empty ghosts as environmental", () => {
    expect(isEnvironmentKiller({ botId: "", name: "environment" })).toBe(true);
    expect(isEnvironmentKiller({ botId: "", name: "" })).toBe(true);
    expect(isEnvironmentKiller({ botId: "zone", name: "" })).toBe(true);
    expect(isEnvironmentKiller({ botId: "bot-42", name: "SlayerBot" })).toBe(false);
  });

  it("classifies the round from the last death record", () => {
    expect(classifyCauseOfDeath({ won: true, killedBy: [] })).toBe("won");
    expect(classifyCauseOfDeath({ won: false, killedBy: [] })).toBe("no_death_recorded");
    expect(
      classifyCauseOfDeath({ won: false, killedBy: [{ botId: "", name: "environment", weapon: "" }] }),
    ).toBe("environment");
    expect(
      classifyCauseOfDeath({
        won: false,
        killedBy: [
          { botId: "", name: "environment", weapon: "" },
          { botId: "b1", name: "Foe", weapon: "bow" },
        ],
      }),
    ).toBe("bot_kill");
  });
});

describe("isSourceRicher (knowledge dump merge guard)", () => {
  const file = (content: unknown): string => {
    const p = join(mkdtempSync(join(tmpdir(), "know-")), "m.json");
    writeFileSync(p, JSON.stringify(content));
    return p;
  };

  it("richer history wins; recency only breaks exact ties", () => {
    const rich = file({ savedAt: 1, rounds: [1, 2, 3] });
    const poorButFresh = file({ savedAt: 999, rounds: [1] });
    expect(isSourceRicher(rich, poorButFresh)).toBe(true);
    expect(isSourceRicher(poorButFresh, rich)).toBe(false);
    const tieOld = file({ savedAt: 1, rounds: [1, 2] });
    const tieNew = file({ savedAt: 2, rounds: [3, 4] });
    expect(isSourceRicher(tieNew, tieOld)).toBe(true);
  });

  it("corrupt source never clobbers a valid destination (fails closed)", () => {
    const good = file({ savedAt: 1, rounds: [1] });
    const corrupt = join(mkdtempSync(join(tmpdir(), "know-")), "broken.json");
    writeFileSync(corrupt, "{not json");
    expect(isSourceRicher(corrupt, good)).toBe(false);
    expect(isSourceRicher(good, corrupt)).toBe(true); // nothing valid to protect
  });
});
