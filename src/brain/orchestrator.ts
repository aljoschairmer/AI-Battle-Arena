import { config } from "../config";
import { arenaRest } from "../arena/rest";
import { type Bus, Channels, Keys } from "../bus";
import { child } from "../shared/logger";
import { normalizeStats } from "../shared/stats";
import {
  DEFAULT_INSIGHTS,
  OpponentRegistry,
  RoundHistory,
  type LearningInsights,
  type RoundOutcome,
} from "../shared/memory";
import type {
  Directive,
  EnginePolicy,
  GameSnapshot,
  LoadoutPlan,
  LoadoutRequest,
} from "../types/internal";
import { DEFAULT_DIRECTIVE, DEFAULT_POLICY, mergePolicy } from "../types/internal";
import type { LeaderboardEntry } from "../types/protocol";
import { AnalystAgent } from "./agents/analyst";
import { LoadoutAgent } from "./agents/loadout";
import { StrategistAgent } from "./agents/strategist";
import { TacticianAgent } from "./agents/tactician";
import { TunerAgent } from "./agents/tuner";
import type { StrategyOutput, TacticOutput } from "./agents/schemas";

const log = child("brain");

interface MetaCache {
  leaderboardTop: { name: string; elo: number; kills: number }[];
  bounties: { name: string; bounty: number }[];
  fetchedAt: number;
}

interface OurStats {
  elo: number;
  kills: number;
  deaths: number;
  kd_ratio: number;
  best_streak: number;
  rounds_played: number;
  round_wins: number;
}

/**
 * The multi-agent coordinator. Owns all four LLM agents and turns their
 * outputs into a coherent Directive pushed to the Engine over the bus.
 *
 * Cadence:
 *   Loadout agent:   on demand, when the Engine asks (round/connect)
 *   Strategist:      once per new round (slow, strong model)
 *   Tactician:       every TACTICIAN_INTERVAL_MS during a live round (fast)
 *   Analyst:         once after each round ends (self-improvement loop)
 *
 * Self-improvement loop:
 *   Engine publishes RoundOutcome → Orchestrator feeds it to AnalystAgent →
 *   Analyst produces LearningInsights → stored in KV + fed to Strategist/Loadout
 *   next round. Every round the bot gets smarter about the meta.
 */
export class Orchestrator {
  private readonly loadoutAgent = new LoadoutAgent();
  private readonly strategist = new StrategistAgent();
  private readonly tactician = new TacticianAgent();
  private readonly analyst = new AnalystAgent();
  private readonly tuner = new TunerAgent();

  private directive: Directive = { ...DEFAULT_DIRECTIVE };
  private version = 0;
  private latest: GameSnapshot | null = null;
  private lastStrategyRound = -999;

  private strategistBusy = false;
  private tacticianBusy = false;
  private analystBusy = false;
  private tunerBusy = false;
  private policy: EnginePolicy = { ...DEFAULT_POLICY };

  private readonly weaponSeen = new Map<string, number>();
  private meta: MetaCache = { leaderboardTop: [], bounties: [], fetchedAt: 0 };
  private ourStats: OurStats | null = null;

  // Self-improvement state
  private readonly roundHistory = new RoundHistory(30);
  private readonly opponents = new OpponentRegistry();
  private insights: LearningInsights = { ...DEFAULT_INSIGHTS };

  private tacticianTimer: NodeJS.Timeout | null = null;
  private unsubs: Array<() => void> = [];

  constructor(private readonly bus: Bus) {}

  async start(): Promise<void> {
    // Resume version numbering so the Engine's "newer-only" filter keeps working.
    const seeded = await this.bus.getKV<Directive>(Keys.currentDirective);
    if (seeded) {
      this.version = seeded.version;
      this.directive = seeded;
    }

    // Restore persisted insights from previous session if available.
    const savedInsights = await this.bus.getKV<LearningInsights>(Keys.learningInsights);
    if (savedInsights) {
      this.insights = savedInsights;
      log.info({ lessons: this.insights.lessons.length, round: this.insights.analysedThroughRound }, "restored learning insights");
    }

    // Restore the live tuning policy so learned knobs survive a restart.
    const savedPolicy = await this.bus.getKV<EnginePolicy>(Keys.currentPolicy);
    if (savedPolicy) {
      this.policy = savedPolicy;
      log.info({ v: savedPolicy.version }, "restored tuning policy");
    }

    this.unsubs.push(
      await this.bus.subscribe<GameSnapshot>(Channels.snapshot, (s) => this.onSnapshot(s)),
    );
    this.unsubs.push(
      await this.bus.subscribe<LoadoutRequest>(Channels.loadoutRequest, (r) =>
        void this.onLoadoutRequest(r),
      ),
    );
    this.unsubs.push(
      await this.bus.subscribe<RoundOutcome>(Channels.roundOutcome, (o) =>
        void this.onRoundOutcome(o),
      ),
    );

    this.tacticianTimer = setInterval(
      () => void this.tick(),
      Math.max(800, config.openrouter.tacticianIntervalMs),
    );

    void this.refreshMeta();
    log.info(
      {
        strategist: config.openrouter.models.strategist,
        tactician: config.openrouter.models.tactician,
        loadout: config.openrouter.models.loadout,
        tacticianIntervalMs: config.openrouter.tacticianIntervalMs,
      },
      "brain started",
    );
  }

  async stop(): Promise<void> {
    if (this.tacticianTimer) clearInterval(this.tacticianTimer);
    for (const u of this.unsubs) u();
    this.unsubs = [];
    log.info("brain stopped");
  }

  // --- event handlers --------------------------------------------------------

  private onSnapshot(snap: GameSnapshot): void {
    this.latest = snap;
    for (const e of snap.enemies) {
      this.weaponSeen.set(e.weapon, (this.weaponSeen.get(e.weapon) ?? 0) + 1);
      // Update opponent registry with live sightings.
      this.opponents.recordSighting(e.id, e.name, e.weapon, snap.round);
    }
    // New round -> re-plan strategy.
    if (snap.round !== this.lastStrategyRound) {
      this.lastStrategyRound = snap.round;
      void this.runStrategist(snap);
    }
  }

  /** Periodic tactician pass over the freshest snapshot. */
  private async tick(): Promise<void> {
    const snap = this.latest;
    if (!snap) return;
    if (Date.now() - snap.ts > 4000) return;
    if (snap.enemies.length === 0) return;
    if (this.tacticianBusy) return;

    this.tacticianBusy = true;
    try {
      const out = await this.tactician.run({ snapshot: snap, current: this.directive });
      if (out) this.applyTactic(out, snap);
    } finally {
      this.tacticianBusy = false;
    }
  }

  private async runStrategist(snap: GameSnapshot): Promise<void> {
    if (this.strategistBusy) return;
    this.strategistBusy = true;
    try {
      await this.refreshMeta();
      const out = await this.strategist.run({
        snapshot: snap,
        meta: {
          ...this.meta,
          ourStats: this.ourStats,
          insights: this.insights,
          opponentProfiles: this.opponents.forPrompt(8),
        },
      });
      if (out) this.applyStrategy(out, snap);
    } finally {
      this.strategistBusy = false;
    }
  }

  private async onLoadoutRequest(req: LoadoutRequest): Promise<void> {
    // Cache our latest lifetime stats.
    if (req.context.ourStats) this.ourStats = req.context.ourStats;

    // Sync leaderboard ELOs into the opponent registry.
    void this.refreshMeta().then(() => {
      for (const e of this.meta.leaderboardTop as (LeaderboardEntry & { bot_id?: string })[]) {
        if (e.bot_id) this.opponents.upsertFromLeaderboard(e as { bot_id: string; name: string; elo: number });
      }
    });

    await this.refreshMeta();
    const out = await this.loadoutAgent.run({
      request: req,
      meta: {
        leaderboardTop: this.meta.leaderboardTop,
        weaponPopularity: this.weaponPopularity(),
        ourStats: req.context.ourStats,
        arenaBotsConnected: req.context.arenaBotsConnected,
        insights: this.insights,
      },
    });

    let plan: LoadoutPlan;
    const c = req.context.constraints;
    if (out) {
      plan = {
        weapon: out.weapon,
        stats: normalizeStats(out.stats, c.statBudget, c.statMin, c.statMax),
        fallback_behavior: out.fallback_behavior,
        reasoning: out.reasoning,
        source: "loadout-agent",
      };
    } else {
      plan = { ...req.fallback, reasoning: "fallback (agent unavailable)", source: "fallback" };
    }
    await this.bus.publish(Channels.loadoutPlan, plan);
    await this.bus.setKV(Keys.currentLoadoutPlan, plan);
    log.info({ weapon: plan.weapon, source: plan.source }, "loadout plan published");
  }

  /** Self-improvement loop: Analyst runs after each round to update insights. */
  private async onRoundOutcome(outcome: RoundOutcome): Promise<void> {
    // Record into history and opponent registry.
    this.roundHistory.push(outcome);
    for (const k of outcome.killedBy) {
      this.opponents.recordKilledUs(k.botId, k.name, k.weapon, outcome.round);
    }
    for (const k of outcome.weKilled) {
      this.opponents.recordWeKilled(k.botId, k.name, outcome.round);
    }

    log.info(
      { round: outcome.round, kills: outcome.kills, deaths: outcome.deaths, won: outcome.won, rounds: this.roundHistory.size() },
      "round outcome recorded",
    );

    // Need a couple of rounds of evidence before learning/tuning.
    if (this.roundHistory.size() < 2) return;

    // Run the two post-round agents in parallel: the Analyst updates strategic
    // insights; the Tuner rewrites the engine's live behaviour policy.
    await Promise.all([this.runAnalyst(outcome), this.runTuner(outcome)]);
  }

  /** Analyst: distil strategic lessons from recent rounds into insights. */
  private async runAnalyst(outcome: RoundOutcome): Promise<void> {
    if (this.analystBusy) return;
    this.analystBusy = true;
    try {
      const summary = this.roundHistory.summary();
      const out = await this.analyst.run({
        recentRounds: this.roundHistory.recent(10),
        historySummary: summary as AnalystInput["historySummary"],
        opponentProfiles: this.opponents.forPrompt(8),
        currentInsights: this.insights,
      });
      if (out) {
        this.insights = this.analyst.toInsights(out, outcome.round);
        await this.bus.setKV(Keys.learningInsights, this.insights);
        log.info(
          {
            lessons: this.insights.lessons.length,
            weapon: this.insights.recommendedWeapon,
            posture: this.insights.suggestedPosture,
            dangerous: this.insights.dangerousOpponents,
          },
          "learning insights updated",
        );
      }
    } finally {
      this.analystBusy = false;
    }
  }

  /**
   * Tuner: the agentic control loop. Rewrites the engine's behaviour policy live
   * based on how the fight is going, then pushes it to the Engine over the bus —
   * the bot re-tunes itself mid-session with no restart.
   */
  private async runTuner(outcome: RoundOutcome): Promise<void> {
    if (this.tunerBusy) return;
    this.tunerBusy = true;
    try {
      const s = this.roundHistory.summary();
      const patch = await this.tuner.run({
        current: this.policy,
        recentRounds: this.roundHistory.recent(6),
        historySummary: { rounds: s.rounds, wins: s.wins, totalKills: s.totalKills, totalDeaths: s.totalDeaths },
        insights: this.insights,
      });
      if (patch) {
        this.policy = mergePolicy(this.policy, { ...patch, source: "tuner" });
        await this.bus.publish(Channels.policy, this.policy);
        await this.bus.setKV(Keys.currentPolicy, this.policy);
        log.info(
          { v: this.policy.version, dodge: this.policy.dodgeEagerness, kite: this.policy.kiteRangeBias, why: this.policy.reasoning },
          "tuning policy updated (live)",
        );
      }
    } finally {
      this.tunerBusy = false;
    }
  }

  // --- directive assembly ----------------------------------------------------

  private applyStrategy(out: StrategyOutput, snap: GameSnapshot): void {
    const next: Directive = {
      version: ++this.version,
      ts: Date.now(),
      round: snap.round,
      posture: out.posture,
      objective: out.objective,
      primaryTargetId: this.sanitizeId(out.primaryTargetId, snap),
      avoidTargetIds: this.sanitizeIds(out.avoidTargetIds, snap),
      hpRetreatFraction: out.hpRetreatFraction,
      aggression: out.aggression,
      reasoning: out.reasoning,
      source: "strategist",
    };
    this.publish(next);
  }

  private applyTactic(out: TacticOutput, snap: GameSnapshot): void {
    const next: Directive = {
      ...this.directive,
      version: ++this.version,
      ts: Date.now(),
      round: snap.round,
      posture: out.posture,
      primaryTargetId: this.sanitizeId(out.primaryTargetId, snap),
      avoidTargetIds: this.sanitizeIds(out.avoidTargetIds, snap),
      hpRetreatFraction: out.hpRetreatFraction,
      aggression: out.aggression,
      reasoning: out.reasoning,
      source: "tactician",
    };
    this.publish(next);
  }

  private publish(d: Directive): void {
    this.directive = d;
    void this.bus.publish(Channels.directive, d);
    void this.bus.setKV(Keys.currentDirective, d);
    log.debug(
      { v: d.version, posture: d.posture, objective: d.objective, target: d.primaryTargetId, src: d.source },
      "directive published",
    );
  }

  // --- helpers ---------------------------------------------------------------

  private sanitizeId(id: string | null, snap: GameSnapshot): string | null {
    if (!id) return null;
    return snap.enemies.some((e) => e.id === id) ? id : null;
  }

  private sanitizeIds(ids: string[], snap: GameSnapshot): string[] {
    const present = new Set(snap.enemies.map((e) => e.id));
    return ids.filter((id) => present.has(id));
  }

  private weaponPopularity(): Record<string, number> {
    return Object.fromEntries(this.weaponSeen);
  }

  private async refreshMeta(): Promise<void> {
    if (Date.now() - this.meta.fetchedAt < 30_000) return;
    const [lb, bounty] = await Promise.all([
      arenaRest.tryGetLeaderboard(16),
      arenaRest.tryGetBounties(),
    ]);
    if (lb) {
      // Sync all leaderboard entries into the opponent registry.
      for (const e of lb.entries) {
        if (e.bot_id) {
          this.opponents.upsertFromLeaderboard({ bot_id: e.bot_id, name: e.name, elo: e.elo });
        }
      }
    }
    this.meta = {
      leaderboardTop: Array.isArray(lb?.entries)
        ? lb!.entries.map((e) => ({ name: e.name, elo: e.elo, kills: e.kills, bot_id: e.bot_id } as LeaderboardEntry & { bot_id?: string }))
        : this.meta.leaderboardTop,
      bounties: Array.isArray(bounty?.entries)
        ? bounty!.entries.map((e) => ({ name: e.name, bounty: e.bounty ?? 0 }))
        : this.meta.bounties,
      fetchedAt: Date.now(),
    };
  }
}

// Import needed for type reference in onRoundOutcome
import type { AnalystInput } from "./agents/analyst";
