import { config } from "../../config";
import type { Directive, GameSnapshot } from "../../types/internal";
import { Agent } from "./base";
import { TacticOutputSchema, type TacticOutput } from "./schemas";

export interface TacticianInput {
  snapshot: GameSnapshot;
  current: Directive;
}

/**
 * Tactician agent — the "fight caller". Runs frequently (every couple of
 * seconds) on a fast, cheap model to make in-the-moment adjustments within the
 * strategist's plan: switch focus to a freshly-exposed target, flip to retreat
 * when ganked, dial aggression up when an enemy is low. Cheap + frequent by
 * design; the strategist owns the slow, expensive big picture.
 */
export class TacticianAgent extends Agent<TacticianInput, TacticOutput> {
  readonly name = "tactician";
  protected readonly model = config.openrouter.models.tactician;
  protected readonly schema = TacticOutputSchema;
  protected override temperature = 0.3;
  protected override maxTokens = 300;

  protected systemPrompt(): string {
    return [
      "You are the TACTICIAN for an AI Battle Arena bot. A deterministic controller fights every 100ms;",
      "you make quick mid-fight adjustments to the policy it reads. Keep within the strategist's intent but react to the moment.",
      "",
      "Output:",
      "- posture: aggressive | balanced | defensive | retreat",
      "- primaryTargetId: enemy bot_id to focus right now, or null",
      "- avoidTargetIds: enemy bot_ids to disengage from",
      "- hpRetreatFraction (0-1), aggression (0-1)",
      "",
      "Heuristics: focus the lowest-HP enemy in line of sight; retreat if outnumbered nearby or low HP;",
      "press hard (aggression up, retreat threshold down) when you have a kill streak and a healthy lead.",
      "Only use bot_ids present in the enemies list. Respond ONLY with the JSON object.",
    ].join("\n");
  }

  protected userPrompt(input: TacticianInput): string {
    const s = input.snapshot;
    return JSON.stringify(
      {
        me: s.self,
        zone: s.zone,
        enemies: s.enemies,
        current_plan: {
          posture: input.current.posture,
          objective: input.current.objective,
          primaryTargetId: input.current.primaryTargetId,
          aggression: input.current.aggression,
        },
      },
      null,
      0,
    );
  }
}
