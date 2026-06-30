import { config } from "../../config";
import type { LoadoutRequest } from "../../types/internal";
import { Agent } from "./base";
import { LoadoutOutputSchema, type LoadoutOutput } from "./schemas";

export interface LoadoutAgentInput {
  request: LoadoutRequest;
  meta: {
    leaderboardTop: { name: string; elo: number; kills: number }[];
    weaponPopularity: Record<string, number>;
  };
}

/**
 * Loadout agent — the "drafting" brain. Picks weapon + stat distribution once
 * per connection, weighing the round modifier and the current meta (who's
 * winning and what they run). Output is schema-validated and stat-normalised by
 * the orchestrator before it ever reaches the server.
 */
export class LoadoutAgent extends Agent<LoadoutAgentInput, LoadoutOutput> {
  readonly name = "loadout";
  protected readonly model = config.openrouter.models.loadout;
  protected readonly schema = LoadoutOutputSchema;
  protected override temperature = 0.5;

  protected systemPrompt(): string {
    return [
      "You are the LOADOUT strategist for a bot in AI Battle Arena, a 10Hz free-for-all.",
      "You choose ONE weapon and distribute exactly 20 stat points (each stat 1-10) across hp, speed, attack, defense.",
      "",
      "Weapons:",
      "- sword: melee cleave, reliable bruiser.",
      "- daggers: fast melee, big backstab damage from behind; squishy.",
      "- shield: melee, high survivability + damage reduction.",
      "- spear: reach-2 melee, can brace vs chargers.",
      "- bow: ranged ~7, charged shots; strong but fragile if caught.",
      "- staff: ranged ~5 AoE burn fields, good vs clusters.",
      "- grapple: long pull/slam control.",
      "",
      "Stat effects: hp = 100 + 10*hp; attack = 1.0 + 0.1*attack dmg mult; defense = 0.03*defense damage reduction; speed = movement.",
      "Balance survivability and damage; pure glass cannons die to the shrinking zone and ganks.",
      "Respond ONLY with JSON: {weapon, stats:{hp,speed,attack,defense}, fallback_behavior, reasoning}. Stats must be integers 1-10 summing to 20.",
    ].join("\n");
  }

  protected userPrompt(input: LoadoutAgentInput): string {
    const { request, meta } = input;
    const c = request.context.constraints;
    return JSON.stringify(
      {
        round_modifier: request.context.roundModifier || "unknown",
        stat_budget: c.statBudget,
        stat_min: c.statMin,
        stat_max: c.statMax,
        leaderboard_top: meta.leaderboardTop.slice(0, 5),
        opponent_weapon_popularity: meta.weaponPopularity,
        deterministic_fallback: request.fallback,
      },
      null,
      0,
    );
  }
}
