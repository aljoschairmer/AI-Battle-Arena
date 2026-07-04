import { config } from "../../config";
import type { LearningInsights } from "../../shared/memory";
import type { LoadoutRequest } from "../../types/internal";
import { deriveStats, fightPower } from "../../shared/derived";
import { WEAPONS } from "../../engine/weapons";
import { WEAPON_ROLE_META, counterScore } from "../../engine/matchups";
import type { Weapon } from "../../types/protocol";
import { Agent } from "./base";
import { LoadoutOutputSchema, type LoadoutOutput } from "./schemas";

export interface LoadoutAgentInput {
  request: LoadoutRequest;
  meta: {
    leaderboardTop: { name: string; elo: number; kills: number }[];
    weaponPopularity: Record<string, number>;
    /** Live weapon-balance telemetry (tier + meta_score + balance direction,
     * plus short-window recent_form/hit_rate — the hotter signals). */
    weaponMeta: {
      weapon: string;
      tier: string;
      meta_score: number;
      balance: string;
      recent_form?: number;
      hit_rate?: number;
    }[];
    ourStats: {
      elo: number;
      kills: number;
      deaths: number;
      kd_ratio: number;
      best_streak: number;
      rounds_played: number;
      round_wins: number;
      damage_dealt?: number;
      damage_taken?: number;
      time_alive_seconds?: number;
    } | null;
    arenaBotsConnected: number | null;
    insights: LearningInsights;
    /**
     * Cross-round per-opponent memory (OpponentRegistry.forPrompt): who we
     * keep meeting, what they play, and the kill ledger vs us — the input
     * that lets the draft counter-pick known opponents instead of drafting
     * blind every round.
     */
    opponentProfiles: {
      name: string;
      elo: number;
      primaryWeapon: Weapon | null;
      killsVsUs: number;
      deathsVsUs: number;
      roundsFaced: number;
    }[];
    /** Our fleet position (0-based, null when flying solo) and fleet size. */
    fleetIndex: number | null;
    fleetSize: number;
    /** Learned per-weapon results from OUR recent rounds (RoundHistory). */
    weaponWinRates: Partial<Record<Weapon, { wins: number; played: number }>>;
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
      "Exact stat formulas (from the arena's Stat Simulator):",
      "  max_hp = 100 + 10*hp (110..200)  |  speed = 3 + 0.5*speed tiles/s (3.5..8)",
      "  attack_mult = 1.0 + 0.1*attack (1.1..2.0)  |  defense_red = 0.03*defense, capped 30% (3%..30%)",
      "  effective_hp = max_hp / (1 - defense_red)   <- true survivability; your time-to-die = effective_hp / enemy_raw_dps",
      "  dmg_per_hit = weapon_base * attack_mult * (1 - enemy_defense_red);  dps = dmg_per_hit / cooldown.",
      "Stat value (KEY): effective_hp already FULLY credits defense, and defense only buys 3%/pt (max 30%),",
      "  so per point it's the WEAKEST stat. Fight power ~= effective_hp * attack_mult is maximised by splitting",
      "  the budget ~evenly between HP and ATTACK with LOW defense (2, or 4 on shield) and speed 5-6 for",
      "  positioning. Do NOT stack defense; a flat 5/5/5/5 leaves ~9% fight power on the table. Avoid glass",
      "  cannons too (speed<4 or hp<4 dies to the shrinking zone and ganks) — aim hp 6-8, attack 6-8, defense 2-4.",
      "",
      "FLEET DIVERSITY — BINDING when fleet_size > 1, and it OVERRIDES the decision priority list below:",
      "our coalition drafts N bots from identical information, which converges on N copies of one weapon —",
      "a mirrored fleet shares one set of weaknesses and gets swept by its counter. Your archetype is fixed",
      "by fleet_index: index 0 = best overall pick (full freedom); index 1 = MUST pick from the ranged",
      "archetype {bow, staff, grapple}; index 2 = MUST pick from the frontline/control archetype",
      "{sword, shield, spear}. Index 1 and 2 must NEVER copy index 0's likely pick.",
      "",
      "EVIDENCE AUTHORITY — our_weapon_history outranks BOTH the archetype defaults and the tier list,",
      "for EVERY slot including index 0. Compute win rate = wins/played for weapons with 10+ played:",
      "- a weapon under 10% win rate over 10+ rounds is BANNED for your slot while any weapon shows 15%+",
      "  over 10+ rounds (measured live: a 'top-tier' melee pick ran 2% over 99 rounds while the ranged slot",
      "  ran 20-28% — tier lists describe other bots' games, history describes OURS)",
      "- index 0 should take the highest-win-rate weapon outright when the evidence is this strong;",
      "  index 1/2 take the best NON-banned weapon from their archetype, or the overall best if their whole",
      "  set is banned. Never end up with two bots on the same weapon when alternatives exist.",
      "",
      "Decision priority (apply top-down, stop at first strong signal):",
      "0. weapon_meta — LIVE balance telemetry: each weapon's tier (S>A>B>C) + meta_score + balance direction",
      "   (buffing/nerfing), plus recent_form (0-100, LAST-FEW-ROUNDS form — a hotter signal than lifetime",
      "   meta_score when they disagree) and hit_rate. Strongly prefer the highest-tier weapon unless a hard",
      "   counter-pick applies; a 'buffing' S/A weapon with high recent_form is the safest default this round.",
      "1. matchup_scores — count-weighted matchup edge of each available weapon vs the lobby (from the arena's",
      "   Strategy matrix, -2..+2). Prefer the HIGHEST matchup_score when the lobby is known; it already encodes the",
      "   hard counters (daggers hard-counter bow & staff; staff hard-counters shield; bow loses hard to daggers).",
      "2. known_opponents — per-opponent history across past rounds (primary weapon + kill ledger vs us).",
      "   If the opponents who beat us repeatedly (killsVsUs > deathsVsUs, 2+ rounds faced) share a known",
      "   primaryWeapon, pick its counter from the matchup matrix (e.g. they run bow/staff -> daggers; they run",
      "   shield -> staff; they run daggers -> sword/spear). Weigh repeat killers over one-off sightings.",
      "3. learning_insights.recommended_weapon — proven best weapon for this meta. Use it UNLESS lobby counter-pick strongly disagrees.",
      "4. round_modifier — hazard_storm/fast_zone: ranged + high speed; pickup_surge: high speed (daggers/grapple); double_bounty: SURVIVAL build (hp/speed over attack — measured 0 wins in 24 double_bounty rounds on aggressive builds; outlive the bloodbath).",
      "5. our_lifetime_stats — kd_ratio < 1.0: add 2 pts to hp+defense; bots_in_arena > 8: add 1 pt to hp (more chaos = more punishment).",
      "6. leaderboard_top — if top-3 ELO bots in lobby all use same weapon type, pick its counter.",
      "",
      "",
      "fallback_behavior steers the bot autonomously when it misses a tick. FLEET RULE (fleet_size > 1):",
      "the server autopilot does NOT know your coalition — a hunter/aggressive autopilot attacks the nearest",
      "bot, teammates included. Fleets MUST pick defensive, territorial, or opportunistic — never hunter or",
      "aggressive. Solo bots pick the one that fits the weapon/stats:",
      "- aggressive: chase and trade (sword/grapple, high attack).",
      "- defensive: hold and survive (shield, high hp/defense).",
      "- opportunistic: poke and pick fights when favourable (staff, balanced).",
      "- territorial: hold a position/range and zone control (bow/spear).",
      "- hunter: hunt the weakest/closest target (daggers, high speed).",
      "",
      "Respond ONLY with JSON: {weapon, stats:{hp,speed,attack,defense}, fallback_behavior, reasoning}. Stats must be integers 1-10 summing to 20. fallback_behavior MUST be one of: aggressive, defensive, opportunistic, territorial, hunter.",
    ].join("\n");
  }

  protected userPrompt(input: LoadoutAgentInput): string {
    const { request, meta } = input;
    const c = request.context.constraints;
    const ins = meta.insights;
    // Concrete derived stats for the deterministic fallback build, so the LLM
    // sees the real effective_hp / dps numbers it's improving on.
    const fb = request.fallback;
    const fbDerived = deriveStats(fb.stats);
    const fbWeapon = WEAPONS[fb.weapon];
    const fallbackDerived = {
      weapon: fb.weapon,
      stats: fb.stats,
      max_hp: Math.round(fbDerived.maxHp),
      effective_hp: Math.round(fbDerived.effectiveHp),
      attack_mult: Number(fbDerived.attackMult.toFixed(2)),
      defense_red_pct: Math.round(fbDerived.defenseRed * 100),
      speed_tiles_s: Number(fbDerived.speed.toFixed(1)),
      fight_power: Math.round(fightPower(fbWeapon.damage, fbWeapon.cooldown, fb.stats)),
    };
    // Matchup edge of each candidate weapon vs the observed lobby (Strategy
    // matrix). Only meaningful when we actually saw lobby weapons.
    const lobby = request.context.lobbyWeapons;
    const haveLobby = Object.keys(lobby).length > 0;
    const matchupScores = haveLobby
      ? (Object.keys(WEAPONS) as Weapon[])
          .map((w) => ({ weapon: w, score: Number(counterScore(w, lobby).toFixed(2)), counters: WEAPON_ROLE_META[w].counter }))
          .sort((a, b) => b.score - a.score)
      : null;
    return JSON.stringify(
      {
        round_modifier: request.context.roundModifier || "none",
        fight_power_optimal_fallback: fallbackDerived,
        matchup_scores: matchupScores,
        weapon_meta: meta.weaponMeta.slice(0, 7),
        bots_in_arena: meta.arenaBotsConnected,
        stat_budget: c.statBudget,
        stat_min: c.statMin,
        stat_max: c.statMax,
        our_lifetime_stats: meta.ourStats,
        lobby_weapons_seen: haveLobby ? lobby : null,
        learning_insights: ins.lessons.length > 0 ? {
          lessons: ins.lessons,
          recommended_weapon: ins.recommendedWeapon,
          recommended_weapon_reason: ins.recommendedWeaponReason,
          dangerous_opponents: ins.dangerousOpponents,
          suggested_posture: ins.suggestedPosture,
        } : null,
        fleet_index: meta.fleetIndex,
        fleet_size: meta.fleetSize,
        our_weapon_history: Object.keys(meta.weaponWinRates).length > 0 ? meta.weaponWinRates : null,
        known_opponents: meta.opponentProfiles.length > 0 ? meta.opponentProfiles : null,
        leaderboard_top: meta.leaderboardTop.slice(0, 6),
        opponent_weapon_popularity: meta.weaponPopularity,
        deterministic_fallback: request.fallback,
      },
      null,
      0,
    );
  }
}
