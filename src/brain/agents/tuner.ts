import { config } from "../../config";
import type { EnginePolicy } from "../../types/internal";
import type { LearningInsights, RoundOutcome } from "../../shared/memory";
import { Agent } from "./base";
import { PolicyPatchSchema, type PolicyPatch } from "./schemas";

export interface TunerInput {
  current: EnginePolicy;
  recentRounds: RoundOutcome[];
  historySummary: {
    rounds: number;
    wins: number;
    totalKills: number;
    totalDeaths: number;
  };
  insights: LearningInsights;
}

/**
 * Tuner agent — the bot's "live mechanic". After each round it inspects how the
 * fight is going and rewrites the engine's behaviour POLICY (dodge eagerness,
 * kite distance, target weights, mine usage, zone margin, …). The engine applies
 * the new policy on the very next tick — so the bot is re-tuned WITHOUT a code
 * change or container restart. This is the agentic control loop: the LLM owns
 * the knobs, the deterministic controller executes them at 10 Hz.
 *
 * Output is a partial patch; mergePolicy() clamps every value to a safe range,
 * so a wild suggestion can nudge behaviour but never break it.
 */
export class TunerAgent extends Agent<TunerInput, PolicyPatch> {
  readonly name = "tuner";
  protected readonly model = config.openrouter.models.strategist;
  protected readonly schema = PolicyPatchSchema;
  protected override temperature = 0.3;
  protected override maxTokens = 500;

  protected systemPrompt(): string {
    return [
      "You are the TUNER for an AI Battle Arena bot. A deterministic controller fights at 10 Hz using",
      "a set of numeric behaviour knobs (the 'policy'). After each round you adjust those knobs to win",
      "more. Output ONLY the fields you want to change; omit the rest.",
      "",
      "Knobs (current values are provided) and their meaning + safe ranges:",
      "- dodgeEagerness (0..1): how readily we spend the 30-tick dodge. Raise if we're getting hit by",
      "  melee/arrows; lower if we waste dodges and then eat hits on cooldown.",
      "- kiteRangeBias (-3..+3 tiles): ranged fighting distance. Raise to play safer/further; lower to",
      "  apply pressure. Negative is for brawlers.",
      "- grappleCloseMinGap (0.5..8): melee weapons grapple to close when the gap exceeds attack_range+this.",
      "- targetLowHpWeight (0..150): how strongly we prioritise finishing low-HP enemies.",
      "- targetCloseWeight (0..10): how strongly we prefer closer targets.",
      "- targetThreatAversion (0..120): how much we avoid high-threat enemies. Raise if we die to ganks.",
      "- pickupDetourMax (0..20 tiles): how far we'll detour for loot. Lower to fight more, raise to sustain.",
      "- zoneEdgeMargin (0..20 tiles): how early we drift to the next safe zone. Raise if we take zone damage.",
      "- mineWhenChased (bool), mineChaseRange (1..10), mineCooldownTicks (5..100): mine kiting behaviour.",
      "",
      "Reason from EVIDENCE: look at deaths vs kills, what weapons killed us, how long we survived, and",
      "whether we're winning. Make SMALL, targeted changes (1-4 knobs). If we're winning, mostly leave it.",
      "Respond ONLY with a JSON object of the knobs to change plus a short 'reasoning'.",
    ].join("\n");
  }

  protected userPrompt(input: TunerInput): string {
    return JSON.stringify(
      {
        current_policy: input.current,
        history: input.historySummary,
        recent_rounds: input.recentRounds.slice(-6).map((r) => ({
          weapon: r.ourWeapon,
          kills: r.kills,
          deaths: r.deaths,
          won: r.won,
          ticksSurvived: r.ticksSurvived,
          killedBy: r.killedBy.map((k) => k.weapon),
        })),
        insights: { lessons: input.insights.lessons, posture: input.insights.suggestedPosture },
      },
      null,
      0,
    );
  }
}
