import { config } from "../../config";
import type { LearningInsights } from "../../shared/memory";
import type { GameSnapshot } from "../../types/internal";
import { Agent } from "./base";
import { StrategyOutputSchema, type StrategyOutput } from "./schemas";

export interface StrategistInput {
  snapshot: GameSnapshot;
  meta: {
    leaderboardTop: { name: string; elo: number; kills: number }[];
    bounties: { name: string; bounty: number; botId: string | null }[];
    ourStats: {
      elo: number;
      kills: number;
      deaths: number;
      kd_ratio: number;
      best_streak: number;
      rounds_played: number;
      round_wins: number;
    } | null;
    insights: LearningInsights;
    opponentProfiles: {
      name: string;
      elo: number;
      primaryWeapon: string | null;
      killsVsUs: number;
      deathsVsUs: number;
      roundsFaced: number;
    }[];
  };
}

/**
 * Strategist agent — the "coach". Runs once per round to set the high-level
 * game plan. Now enriched with self-improvement data: learning insights from
 * the Analyst and per-opponent profiles built over many rounds.
 */
export class StrategistAgent extends Agent<StrategistInput, StrategyOutput> {
  readonly name = "strategist";
  protected readonly model = config.openrouter.models.strategist;
  protected readonly schema = StrategyOutputSchema;
  protected override temperature = 0.65;
  protected override maxTokens = 600;

  protected systemPrompt(): string {
    return [
      "You are the STRATEGIST for an AI Battle Arena bot in a multi-bot free-for-all with a shrinking safe zone.",
      "A fast deterministic controller executes combat every 100ms; YOU set the high-level policy it reads each round.",
      "",
      "Output fields:",
      "- posture: aggressive | balanced | defensive | retreat",
      "- objective: hunt_bounty | engage_weakest | control_center | farm_pickups | survive | free_for_all",
      "- primaryTargetId: bot_id of the best kill target this round, or null",
      "- avoidTargetIds: bot_ids that are too dangerous (add them; controller will disengage)",
      "- hpRetreatFraction (0-1): retreat when hp/maxHp drops below this. Typical: 0.20-0.35",
      "- aggression (0-1): 0=flee/loot only, 1=press every fight. Typical: 0.4-0.75",
      "",
      "Decision framework:",
      "1. OPPONENT PROFILES — opponent_profiles shows (killsVsUs - deathsVsUs) net score per bot.",
      "   Positive net = they beat us → add to avoidTargetIds. Negative net = we beat them → consider primaryTargetId.",
      "   If roundsFaced=0, use ELO as proxy: ELO > ours+200 = dangerous, ELO < ours-100 = weak.",
      "2. LEARNING INSIGHTS — treat lessons as hard rules from painful experience. Always apply suggestedPosture",
      "   unless you have a strong contextual reason to override (e.g. you're the last bot standing).",
      "   dangerousOpponents: add any that appear in enemies list to avoidTargetIds.",
      "3. ROUND MODIFIER — hazard_storm/fast_zone: prefer survival (hpRetreatFraction 0.35+, aggressive < 0.5).",
      "   pickup_surge: farm_pickups objective + moderate aggression. double_bounty: hunt_bounty + high aggression.",
      "4. OUR STATS — kd_ratio < 1.0: play defensively (posture=defensive, hpRetreatFraction 0.35).",
      "   kd_ratio > 2.0: we're winning the meta — press harder (aggression 0.7+).",
      "5. LEADERBOARD — top-ELO bots are extremely dangerous. Add any in the current enemies list to avoidTargetIds",
      "   unless they're below 30% HP or stunned.",
      "6. BOUNTIES — bounties lists bots carrying a public bounty (botId + amount). If a bounty carrier's",
      "   botId appears in the enemies list and it isn't a top-ELO avoid target, set objective=hunt_bounty and",
      "   primaryTargetId to THAT botId (match by botId, or by name when botId is null). Bounty kills are",
      "   direct score; during double_bounty they're worth double — prioritize them aggressively then.",
      "7. ZONE — use nearby_hazards and nearby_terrain to judge choke points and safe angles.",
      "   If distance_to_zone_edge < 5, factor zone movement into objective (survive > hunt).",
      "Only reference bot_ids that appear in the provided enemies list.",
      "Respond ONLY with JSON: {posture, objective, primaryTargetId, avoidTargetIds, hpRetreatFraction, aggression, reasoning}.",
    ].join("\n");
  }

  protected userPrompt(input: StrategistInput): string {
    const s = input.snapshot;
    const m = input.meta;
    return JSON.stringify(
      {
        round: s.round,
        round_modifier: s.roundModifier,
        me: s.self,
        our_lifetime_stats: m.ourStats,
        learning_insights: m.insights.lessons.length > 0 ? {
          lessons: m.insights.lessons,
          recommended_weapon: m.insights.recommendedWeapon,
          dangerous_opponents: m.insights.dangerousOpponents,
          weak_opponents: m.insights.weakOpponents,
          suggested_posture: m.insights.suggestedPosture,
        } : null,
        opponent_profiles: m.opponentProfiles,
        zone: s.zone,
        enemies: s.enemies,
        nearby_pickups: s.nearbyPickups,
        nearby_hazards: s.nearbyHazards,
        nearby_terrain: s.nearbyTerrain,
        last_seen_enemies: s.lastSeenEnemies,
        recent_kills: s.recentKills,
        leaderboard_top: m.leaderboardTop.slice(0, 8),
        bounties: m.bounties.slice(0, 5),
      },
      null,
      0,
    );
  }
}
