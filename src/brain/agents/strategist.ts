import { config } from "../../config";
import type { GameSnapshot } from "../../types/internal";
import { Agent } from "./base";
import { StrategyOutputSchema, type StrategyOutput } from "./schemas";

export interface StrategistInput {
  snapshot: GameSnapshot;
  meta: {
    leaderboardTop: { name: string; elo: number; kills: number }[];
    bounties: { name: string; bounty: number }[];
  };
}

/**
 * Strategist agent — the "coach". Runs once per round (and on big swings) to set
 * the high-level game plan: posture, objective, who to hunt, who to avoid, and
 * the HP threshold at which the Engine should bail. Slow, deliberate, uses the
 * stronger model.
 */
export class StrategistAgent extends Agent<StrategistInput, StrategyOutput> {
  readonly name = "strategist";
  protected readonly model = config.openrouter.models.strategist;
  protected readonly schema = StrategyOutputSchema;
  protected override temperature = 0.45;

  protected systemPrompt(): string {
    return [
      "You are the STRATEGIST for an AI Battle Arena bot in a multi-bot free-for-all with a shrinking safe zone.",
      "A fast deterministic controller executes combat every 100ms; YOU only set high-level policy it reads.",
      "",
      "Decide:",
      "- posture: aggressive | balanced | defensive | retreat",
      "- objective: hunt_bounty | engage_weakest | control_center | farm_pickups | survive | free_for_all",
      "- primaryTargetId: an enemy bot_id to focus, or null to let the controller pick",
      "- avoidTargetIds: enemy bot_ids that are too dangerous to engage right now",
      "- hpRetreatFraction (0-1): retreat/heal when hp/maxHp drops below this",
      "- aggression (0-1): willingness to commit to fights vs play safe and farm",
      "",
      "Principles: don't trade into a much stronger enemy; punish low-HP and stunned targets; respect the zone;",
      "hunt bounties only when you can win the duel; survive late when few bots remain.",
      "Only reference bot_ids that appear in the provided enemies list.",
      "Respond ONLY with JSON matching: {posture, objective, primaryTargetId, avoidTargetIds, hpRetreatFraction, aggression, reasoning}.",
    ].join("\n");
  }

  protected userPrompt(input: StrategistInput): string {
    const s = input.snapshot;
    return JSON.stringify(
      {
        round: s.round,
        round_modifier: s.roundModifier,
        me: s.self,
        zone: s.zone,
        enemies: s.enemies,
        nearby_pickups: s.nearbyPickups,
        recent_kills: s.recentKills,
        leaderboard_top: input.meta.leaderboardTop.slice(0, 5),
        bounties: input.meta.bounties.slice(0, 5),
      },
      null,
      0,
    );
  }
}
