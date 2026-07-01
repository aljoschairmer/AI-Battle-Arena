import { config } from "../../config";
import { Agent } from "./base";
import { CoordinatorOutputSchema, type CoordinatorOutput } from "./schemas";

export interface CoordinatorMember {
  botId: string;
  name: string;
  weapon: string;
  hp: number;
  position: [number, number];
}

export interface CoordinatorEnemy {
  id: string;
  hp: number;
  position: [number, number];
}

export interface CoordinatorInput {
  members: CoordinatorMember[];
  enemies: CoordinatorEnemy[];
  currentFocusTargetId: string | null;
}

/**
 * Coordinator agent — the squad's tactical commander. Unlike the Strategist/
 * Tactician (which each reason about a single bot's own fight), this agent
 * sees the WHOLE coalition at once and calls basic fireteam tactics:
 * concentration of fire on one target, a frontline bot to hold/tank, a
 * mobile bot to exploit the flank, a ranged bot to hang back on support, and
 * when to regroup instead of fighting scattered. Runs infrequently (a few
 * seconds) on pooled intel from the coop channel — never on the hot path.
 */
export class CoordinatorAgent extends Agent<CoordinatorInput, CoordinatorOutput> {
  readonly name = "coordinator";
  protected readonly model = config.openrouter.models.coordinator;
  protected readonly schema = CoordinatorOutputSchema;
  protected override temperature = 0.5;
  protected override maxTokens = 400;

  protected systemPrompt(): string {
    return [
      "You are the COORDINATOR for a squad of allied bots in AI Battle Arena — think fireteam leader,",
      "not individual fighter. You see every ally's position/HP/weapon and the enemies the squad has pooled",
      "intel on. Call basic military tactics:",
      "",
      "- focusTargetId: the ONE enemy bot_id the whole squad should concentrate fire on (usually lowest HP",
      "  or most dangerous-if-ignored). Concentration of force beats everyone picking their own target.",
      "- roles: map each ally's botId to one of hold | flank | support.",
      "    hold    = frontline — tanky/melee weapons (shield, spear, sword) anchor and absorb aggro.",
      "    flank   = mobile — daggers/grapple circle to exposed angles / the enemy's rear.",
      "    support = ranged — bow/staff hang back, keep line of sight, avoid melee range.",
      "  Assign roles that fit each ally's weapon; don't put a bow bot on hold or a shield bot on flank.",
      "- regroup: true only when the squad is scattered far apart AND collectively low HP — call a fallback",
      "  to a shared position instead of fighting piecemeal. False in normal fights.",
      "",
      "Every ally bot_id must appear in `roles`. Only use bot_ids that actually appear in the input.",
      "Respond ONLY with the JSON object.",
    ].join("\n");
  }

  protected userPrompt(input: CoordinatorInput): string {
    return JSON.stringify(
      {
        squad: input.members,
        enemies: input.enemies,
        current_focus: input.currentFocusTargetId,
      },
      null,
      0,
    );
  }
}
