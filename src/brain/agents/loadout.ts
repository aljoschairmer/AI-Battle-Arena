import { config } from "../../config";
import type { LearningInsights } from "../../shared/memory";
import type { LoadoutRequest } from "../../types/internal";
import { Agent } from "./base";
import { LoadoutOutputSchema, type LoadoutOutput } from "./schemas";

export interface LoadoutAgentInput {
  request: LoadoutRequest;
  meta: {
    leaderboardTop: { name: string; elo: number; kills: number }[];
    weaponPopularity: Record<string, number>;
    ourStats: {
      elo: number;
      kills: number;
      deaths: number;
      kd_ratio: number;
      best_streak: number;
      rounds_played: number;
      round_wins: number;
    } | null;
    arenaBotsConnected: number | null;
    insights: LearningInsights;
  };
}

/**
 * Loadout agent — the "drafting" brain. Picks weapon + stat distribution once
 * per round, incorporating self-improvement insights from the Analyst so weapon
 * choices adapt to the current meta and our observed weaknesses.
 */
export class LoadoutAgent extends Agent<LoadoutAgentInput, LoadoutOutput> {
  readonly name = "loadout";
  protected readonly model = config.openrouter.models.loadout;
  protected readonly schema = LoadoutOutputSchema;
  protected override temperature = 0.6;
  protected override maxTokens = 600;

  protected systemPrompt(): string {
    return [
      "You are the LOADOUT strategist for a bot in AI Battle Arena, a 10Hz free-for-all with shrinking zones.",
      "Choose ONE weapon and distribute exactly 20 stat points (each stat 1-10) across hp, speed, attack, defense.",
      "",
      "Weapons:",
      "- sword: melee range-1, cleave hits adjacent enemies. Reliable bruiser.",
      "- daggers: range-1, 0.35s cooldown, big backstab bonus hitting rear. Fast but fragile.",
      "- shield: range-1, melee bash bonus vs disrupted targets. Tankiest melee.",
      "- spear: range-2, can brace vs chargers. Safe melee reach.",
      "- bow: range-8, charged shots; devastating at distance but dies if caught close.",
      "- staff: range-6, AoE burn fields on hit; best vs clusters. Slow cooldown.",
      "- grapple: range-12 pull/slam, 2 charges/round; great mobility tool.",
      "",
      "Stat formulas: hp = 100 + 10*hp  |  attack_mult = 1.0 + 0.1*attack  |  defense_red = 0.03*defense  |  speed = tiles/tick.",
      "Balance survivability and damage — glass cannons die to the shrinking zone and ganks.",
      "",
      "Decision priority (apply top-down, stop at first strong signal):",
      "1. lobby_weapons_seen — THIS round's enemy weapons. Hard counter-picks: 3+ melee → bow/staff; 3+ ranged → daggers/grapple; mixed → sword/spear.",
      "2. learning_insights.recommended_weapon — proven best weapon for this meta. Use it UNLESS lobby counter-pick strongly disagrees.",
      "3. round_modifier — hazard_storm/fast_zone: ranged + high speed; pickup_surge: high speed (daggers/grapple); double_bounty: high attack (bow/daggers).",
      "4. our_lifetime_stats — kd_ratio < 1.0: add 2 pts to hp+defense; bots_in_arena > 8: add 1 pt to hp (more chaos = more punishment).",
      "5. leaderboard_top — if top-3 ELO bots in lobby all use same weapon type, pick its counter.",
      "",
      "Respond ONLY with JSON: {weapon, stats:{hp,speed,attack,defense}, fallback_behavior, reasoning}. Stats must be integers 1-10 summing to 20.",
    ].join("\n");
  }

  protected userPrompt(input: LoadoutAgentInput): string {
    const { request, meta } = input;
    const c = request.context.constraints;
    const ins = meta.insights;
    return JSON.stringify(
      {
        round_modifier: request.context.roundModifier || "none",
        bots_in_arena: meta.arenaBotsConnected,
        stat_budget: c.statBudget,
        stat_min: c.statMin,
        stat_max: c.statMax,
        our_lifetime_stats: meta.ourStats,
        lobby_weapons_seen: Object.keys(request.context.lobbyWeapons).length > 0
          ? request.context.lobbyWeapons
          : null,
        learning_insights: ins.lessons.length > 0 ? {
          lessons: ins.lessons,
          recommended_weapon: ins.recommendedWeapon,
          recommended_weapon_reason: ins.recommendedWeaponReason,
          dangerous_opponents: ins.dangerousOpponents,
          suggested_posture: ins.suggestedPosture,
        } : null,
        leaderboard_top: meta.leaderboardTop.slice(0, 6),
        opponent_weapon_popularity: meta.weaponPopularity,
        deterministic_fallback: request.fallback,
      },
      null,
      0,
    );
  }
}
