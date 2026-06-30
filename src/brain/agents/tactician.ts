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
  protected override temperature = 0.6;
  protected override maxTokens = 350;

  protected systemPrompt(): string {
    return [
      "You are the TACTICIAN for an AI Battle Arena bot. A deterministic controller fights every 100ms;",
      "you make quick mid-fight adjustments to the policy it reads. Keep within the strategist's intent but react to the moment.",
      "",
      "Output fields:",
      "- posture: aggressive | balanced | defensive | retreat",
      "- primaryTargetId: enemy bot_id to focus right now, or null",
      "- avoidTargetIds: enemy bot_ids to disengage from (e.g. full-HP bots ganking you)",
      "- hpRetreatFraction (0-1): retreat below this HP fraction. Normal=0.25, danger=0.40, safe=0.15",
      "- aggression (0-1): 0=flee/loot, 1=press every fight",
      "",
      "Decision rules:",
      "- Focus the LOWEST-HP enemy with LOS. If it's finishable this fight, keep primaryTargetId on it.",
      "- If 2+ enemies are within 3 tiles of you AND your HP < 50%, switch to retreat posture immediately.",
      "- If outnumbered (enemy_count >= 3) and not in a dominant position, go defensive and raise hpRetreatFraction to 0.45.",
      "- If your HP > 70% and only 1 enemy is visible, go aggressive (aggression 0.8+).",
      "- If weapon is on cooldown and enemy is melee range, go defensive briefly to kite out.",
      "- Use last_seen_enemies: if no enemies visible, don't set primaryTargetId — let the bot search.",
      "- Avoid enemies with very high threat_score (>7) unless you have a large HP advantage.",
      "Only use bot_ids from the enemies list. Respond ONLY with the JSON object.",
    ].join("\n");
  }

  protected userPrompt(input: TacticianInput): string {
    const s = input.snapshot;
    return JSON.stringify(
      {
        me: s.self,
        zone: s.zone,
        enemies: s.enemies,
        nearby_hazards: s.nearbyHazards,
        nearby_terrain: s.nearbyTerrain,
        last_seen_enemies: s.lastSeenEnemies,
        enemy_count: s.enemies.length,
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
