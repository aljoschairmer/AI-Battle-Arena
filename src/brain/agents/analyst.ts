import { config } from "../../config";
import type { RoundOutcome } from "../../shared/memory";
import type { LearningInsights } from "../../shared/memory";
import { Agent } from "./base";
import { AnalystOutputSchema, type AnalystOutput } from "./schemas";

export interface AnalystInput {
  recentRounds: RoundOutcome[];
  historySummary: {
    rounds: number;
    wins: number;
    totalKills: number;
    totalDeaths: number;
    weaponWinRates: Record<string, { wins: number; played: number }>;
    modifierKD: Record<string, { kills: number; deaths: number }>;
  };
  opponentProfiles: {
    name: string;
    elo: number;
    primaryWeapon: string | null;
    killsVsUs: number;
    deathsVsUs: number;
    roundsFaced: number;
  }[];
  currentInsights: LearningInsights;
}

/**
 * Analyst agent — the "coach that watches the tape". Runs after each round
 * ends, reviews recent performance, and distills actionable lessons that feed
 * back into the Strategist and Loadout agents. This is the self-improvement
 * loop: each round makes the bot measurably smarter about the meta.
 *
 * Runs on the same strong model as the Strategist but is triggered out-of-band
 * (post-round, not time-critical), so latency doesn't matter.
 */
export class AnalystAgent extends Agent<AnalystInput, AnalystOutput> {
  readonly name = "analyst";
  protected readonly model = config.openrouter.models.strategist;
  protected readonly schema = AnalystOutputSchema;
  protected override temperature = 0.35;
  protected override maxTokens = 600;

  protected systemPrompt(): string {
    return [
      "You are the ANALYST for an AI Battle Arena bot. After each round you review performance data",
      "and produce concise, actionable lessons that the Strategist and Loadout agents will act on.",
      "",
      "You receive:",
      "- recent_rounds: last N completed rounds with kills, deaths, our weapon, enemies, who killed us",
      "- history_summary: aggregate win/KD rates per weapon and per round modifier",
      "- opponent_profiles: per-bot sighting history with kills vs us and their weapon",
      "- current_insights: what the previous analysis concluded (update or keep)",
      "",
      "Produce:",
      "- lessons: up to 6 short bullet-point lessons (e.g. 'Bow users kill us in open ground — stay near walls')",
      "- recommendedWeapon: best weapon for the current meta based on evidence, or null to keep current",
      "- recommendedWeaponReason: one sentence explaining why",
      "- dangerousOpponents: names of bots that reliably beat us — avoid them or retreat on sight",
      "- weakOpponents: names of bots we consistently beat — prioritize as targets",
      "- suggestedPosture: aggressive | balanced | defensive — overall stance for next round",
      "",
      "Base lessons on EVIDENCE from the data. Avoid vague advice. Be specific: name weapons, modifiers, opponents.",
      "If the data is too thin (< 3 rounds), keep lessons minimal and conservative.",
      "Respond ONLY with JSON matching the schema.",
    ].join("\n");
  }

  protected userPrompt(input: AnalystInput): string {
    return JSON.stringify(
      {
        recent_rounds: input.recentRounds.slice(-10),
        history_summary: input.historySummary,
        opponent_profiles: input.opponentProfiles,
        current_insights: {
          lessons: input.currentInsights.lessons,
          recommendedWeapon: input.currentInsights.recommendedWeapon,
          suggestedPosture: input.currentInsights.suggestedPosture,
        },
      },
      null,
      0,
    );
  }

  /** Convert raw agent output into the full LearningInsights shape */
  toInsights(out: AnalystOutput, throughRound: number): LearningInsights {
    return {
      lessons: out.lessons,
      recommendedWeapon: out.recommendedWeapon,
      recommendedWeaponReason: out.recommendedWeaponReason,
      dangerousOpponents: out.dangerousOpponents,
      weakOpponents: out.weakOpponents,
      suggestedPosture: out.suggestedPosture,
      analysedThroughRound: throughRound,
    };
  }
}
