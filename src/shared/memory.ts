import type { Weapon } from "../types/protocol";

/**
 * What happened in a single completed round — recorded by the engine from
 * real socket events, published to the Brain via the bus so the Analyst
 * can learn from it.
 */
export interface RoundOutcome {
  round: number;
  roundModifier: string;
  ourWeapon: Weapon | null;
  kills: number;
  deaths: number;
  /** bot_ids + names that killed us this round ("" weapon = unknown) */
  killedBy: { botId: string; name: string; weapon: Weapon | "" }[];
  /** bot_ids + names we killed this round */
  weKilled: { botId: string; name: string; weapon: Weapon }[];
  /** Weapons we saw on enemies this round */
  enemyWeaponsSeen: Partial<Record<Weapon, number>>;
  /** Did we win (last bot alive)? */
  won: boolean;
  /** Duration in ticks (round-relative, clamped to a sane ceiling) */
  ticksSurvived: number;
  /** HP we finished the round with (0 when we were dead at round end) */
  hpAtDeath: number;
}

/**
 * Accumulated profile for a specific opponent bot, built over many rounds
 * of observation. Stored in the Brain and surfaced to LLM agents.
 */
export interface OpponentProfile {
  botId: string;
  name: string;
  /** ELO from the last leaderboard fetch */
  elo: number;
  /** Weapons we've seen them use, with observation counts */
  weaponsSeen: Partial<Record<Weapon, number>>;
  /** Their most-used weapon (derived) */
  primaryWeapon: Weapon | null;
  /** How many times they've killed us */
  killsVsUs: number;
  /** How many times we've killed them */
  deathsVsUs: number;
  /** Number of rounds we've faced them */
  roundsFaced: number;
  /** Last tick we observed them */
  lastSeenRound: number;
}

/**
 * LLM-produced insights from the Analyst agent — concise lessons derived
 * from recent round history that feed back into the Strategist and Loadout
 * prompts to make future decisions smarter.
 */
export interface LearningInsights {
  /** One-line lessons the Strategist and Loadout agents should internalize */
  lessons: string[];
  /** Recommended weapon for next round, with brief reason */
  recommendedWeapon: Weapon | null;
  recommendedWeaponReason: string;
  /** Opponents we should avoid (too strong for us currently) */
  dangerousOpponents: string[];
  /** Opponents we tend to beat (good targets to hunt) */
  weakOpponents: string[];
  /** Suggested posture shift based on recent performance */
  suggestedPosture: "aggressive" | "balanced" | "defensive";
  /** Round of most recent analysis */
  analysedThroughRound: number;
}

export const DEFAULT_INSIGHTS: LearningInsights = {
  lessons: [],
  recommendedWeapon: null,
  recommendedWeaponReason: "",
  dangerousOpponents: [],
  weakOpponents: [],
  suggestedPosture: "balanced",
  analysedThroughRound: -1,
};

/**
 * Rolling in-memory store for round outcomes. Capped so it doesn't grow
 * unboundedly across a long session.
 */
export class RoundHistory {
  private readonly outcomes: RoundOutcome[] = [];
  private readonly maxRounds: number;

  constructor(maxRounds = 30) {
    this.maxRounds = maxRounds;
  }

  push(outcome: RoundOutcome): void {
    this.outcomes.push(outcome);
    if (this.outcomes.length > this.maxRounds) {
      this.outcomes.splice(0, this.outcomes.length - this.maxRounds);
    }
  }

  /** Snapshot for disk persistence (BrainMemoryStore). */
  toJSON(): RoundOutcome[] {
    return [...this.outcomes];
  }

  /** Restore a persisted snapshot (replaces current contents, keeps the cap). */
  restore(rounds: RoundOutcome[]): void {
    this.outcomes.length = 0;
    for (const r of rounds.slice(-this.maxRounds)) this.outcomes.push(r);
  }

  /** Most recent N rounds, newest last */
  recent(n = 10): RoundOutcome[] {
    return this.outcomes.slice(-n);
  }

  size(): number {
    return this.outcomes.length;
  }

  /** Aggregate stats across stored rounds */
  summary(): {
    rounds: number;
    wins: number;
    totalKills: number;
    totalDeaths: number;
    weaponWinRates: Partial<Record<Weapon, { wins: number; played: number }>>;
    modifierKD: Partial<Record<string, { kills: number; deaths: number }>>;
  } {
    const weaponWinRates: Partial<Record<Weapon, { wins: number; played: number }>> = {};
    const modifierKD: Partial<Record<string, { kills: number; deaths: number }>> = {};
    let wins = 0;
    let totalKills = 0;
    let totalDeaths = 0;

    for (const r of this.outcomes) {
      if (r.won) wins++;
      totalKills += r.kills;
      totalDeaths += r.deaths;

      if (r.ourWeapon) {
        const w = weaponWinRates[r.ourWeapon] ?? { wins: 0, played: 0 };
        w.played++;
        if (r.won) w.wins++;
        weaponWinRates[r.ourWeapon] = w;
      }

      const mod = r.roundModifier || "none";
      const m = modifierKD[mod] ?? { kills: 0, deaths: 0 };
      m.kills += r.kills;
      m.deaths += r.deaths;
      modifierKD[mod] = m;
    }

    return { rounds: this.outcomes.length, wins, totalKills, totalDeaths, weaponWinRates, modifierKD };
  }
}

/**
 * Tracks per-opponent observations across rounds, keyed by bot_id.
 */
export class OpponentRegistry {
  private readonly profiles = new Map<string, OpponentProfile>();

  get(botId: string): OpponentProfile | null {
    return this.profiles.get(botId) ?? null;
  }

  /** Snapshot for disk persistence (BrainMemoryStore). */
  toJSON(): OpponentProfile[] {
    return this.getAll();
  }

  /** Restore a persisted snapshot (replaces current contents). */
  restore(profiles: OpponentProfile[]): void {
    this.profiles.clear();
    for (const p of profiles) {
      if (p && typeof p.botId === "string") this.profiles.set(p.botId, p);
    }
  }

  getAll(): OpponentProfile[] {
    return Array.from(this.profiles.values());
  }

  upsertFromLeaderboard(entry: { bot_id?: string; name: string; elo: number }): void {
    if (!entry.bot_id) return;
    const existing = this.profiles.get(entry.bot_id);
    if (existing) {
      existing.elo = entry.elo;
      existing.name = entry.name;
    } else {
      this.profiles.set(entry.bot_id, {
        botId: entry.bot_id,
        name: entry.name,
        elo: entry.elo,
        weaponsSeen: {},
        primaryWeapon: null,
        killsVsUs: 0,
        deathsVsUs: 0,
        roundsFaced: 0,
        lastSeenRound: -1,
      });
    }
  }

  recordSighting(botId: string, name: string, weapon: Weapon, round: number): void {
    let p = this.profiles.get(botId);
    if (!p) {
      p = {
        botId,
        name,
        elo: 1000,
        weaponsSeen: {},
        primaryWeapon: null,
        killsVsUs: 0,
        deathsVsUs: 0,
        roundsFaced: 0,
        lastSeenRound: -1,
      };
      this.profiles.set(botId, p);
    }
    p.name = name;
    p.weaponsSeen[weapon] = (p.weaponsSeen[weapon] ?? 0) + 1;
    p.primaryWeapon = this.topWeapon(p.weaponsSeen);
    if (p.lastSeenRound !== round) {
      p.lastSeenRound = round;
      p.roundsFaced++;
    }
  }

  recordKilledUs(botId: string, name: string, weapon: Weapon | "", round: number): void {
    if (weapon) {
      this.recordSighting(botId, name, weapon, round);
      const p = this.profiles.get(botId)!;
      p.killsVsUs++;
      return;
    }
    // Unknown weapon: still credit the kill against us, but don't pollute the
    // weapons-seen histogram with a guess.
    let p = this.profiles.get(botId);
    if (!p) {
      p = {
        botId,
        name,
        elo: 1000,
        weaponsSeen: {},
        primaryWeapon: null,
        killsVsUs: 0,
        deathsVsUs: 0,
        roundsFaced: 0,
        lastSeenRound: -1,
      };
      this.profiles.set(botId, p);
    }
    p.name = name || p.name;
    if (p.lastSeenRound !== round) {
      p.lastSeenRound = round;
      p.roundsFaced++;
    }
    p.killsVsUs++;
  }

  recordWeKilled(botId: string, name: string, round: number): void {
    const p = this.profiles.get(botId);
    if (p) {
      p.name = name || p.name; // keep display names fresh (was silently ignored)
      p.deathsVsUs++;
      if (p.lastSeenRound !== round) {
        p.lastSeenRound = round;
        p.roundsFaced++;
      }
    }
  }

  /** Compact view for LLM prompts — sorted by threat (kills vs us desc) */
  forPrompt(limit = 8): {
    name: string;
    elo: number;
    primaryWeapon: Weapon | null;
    killsVsUs: number;
    deathsVsUs: number;
    roundsFaced: number;
  }[] {
    return this.getAll()
      .filter((p) => p.roundsFaced > 0)
      .sort((a, b) => b.killsVsUs - a.killsVsUs || b.elo - a.elo)
      .slice(0, limit)
      .map((p) => ({
        name: p.name,
        elo: p.elo,
        primaryWeapon: p.primaryWeapon,
        killsVsUs: p.killsVsUs,
        deathsVsUs: p.deathsVsUs,
        roundsFaced: p.roundsFaced,
      }));
  }

  private topWeapon(seen: Partial<Record<Weapon, number>>): Weapon | null {
    let best: Weapon | null = null;
    let bestCount = 0;
    for (const [w, n] of Object.entries(seen) as [Weapon, number][]) {
      if (n > bestCount) {
        bestCount = n;
        best = w;
      }
    }
    return best;
  }
}
