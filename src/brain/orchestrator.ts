import { config } from "../config";
import { arenaRest } from "../arena/rest";
import { type Bus, Channels, Keys } from "../bus";
import { child } from "../shared/logger";
import { normalizeStats } from "../shared/stats";
import type { Directive, GameSnapshot, LoadoutPlan, LoadoutRequest } from "../types/internal";
import { DEFAULT_DIRECTIVE } from "../types/internal";
import { LoadoutAgent } from "./agents/loadout";
import { StrategistAgent } from "./agents/strategist";
import { TacticianAgent } from "./agents/tactician";
import type { StrategyOutput, TacticOutput } from "./agents/schemas";

const log = child("brain");

interface MetaCache {
  leaderboardTop: { name: string; elo: number; kills: number }[];
  bounties: { name: string; bounty: number }[];
  fetchedAt: number;
}

/**
 * The multi-agent coordinator. Owns the three LLM agents and turns their
 * outputs into a single coherent Directive that it pushes to the Engine over
 * the bus.
 *
 * Cadence:
 *   - Loadout agent: on demand, when the Engine asks (round/connect).
 *   - Strategist:    once per new round (slow, strong model).
 *   - Tactician:     every TACTICIAN_INTERVAL_MS during a live round (fast model).
 *
 * Every agent is allowed to fail; the orchestrator simply keeps the last good
 * directive, so the Engine is never left without guidance.
 */
export class Orchestrator {
  private readonly loadoutAgent = new LoadoutAgent();
  private readonly strategist = new StrategistAgent();
  private readonly tactician = new TacticianAgent();

  private directive: Directive = { ...DEFAULT_DIRECTIVE };
  private version = 0;
  private latest: GameSnapshot | null = null;
  private lastStrategyRound = -999;

  private strategistBusy = false;
  private tacticianBusy = false;

  private readonly weaponSeen = new Map<string, number>();
  private meta: MetaCache = { leaderboardTop: [], bounties: [], fetchedAt: 0 };

  private tacticianTimer: NodeJS.Timeout | null = null;
  private unsubs: Array<() => void> = [];

  constructor(private readonly bus: Bus) {}

  async start(): Promise<void> {
    // Resume version numbering so the Engine's "newer-only" filter keeps working
    // across a Brain restart.
    const seeded = await this.bus.getKV<Directive>(Keys.currentDirective);
    if (seeded) {
      this.version = seeded.version;
      this.directive = seeded;
    }

    this.unsubs.push(
      await this.bus.subscribe<GameSnapshot>(Channels.snapshot, (s) => this.onSnapshot(s)),
    );
    this.unsubs.push(
      await this.bus.subscribe<LoadoutRequest>(Channels.loadoutRequest, (r) =>
        void this.onLoadoutRequest(r),
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
    // Only bother if state is recent and there's actually something to fight.
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
      const out = await this.strategist.run({ snapshot: snap, meta: this.meta });
      if (out) this.applyStrategy(out, snap);
    } finally {
      this.strategistBusy = false;
    }
  }

  private async onLoadoutRequest(req: LoadoutRequest): Promise<void> {
    await this.refreshMeta();
    const out = await this.loadoutAgent.run({
      request: req,
      meta: { leaderboardTop: this.meta.leaderboardTop, weaponPopularity: this.weaponPopularity() },
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
    // Keep the strategist's objective; override the moment-to-moment fields.
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
    if (Date.now() - this.meta.fetchedAt < 30_000) return; // cache 30s
    const [lb, bounty] = await Promise.all([
      arenaRest.tryGetLeaderboard(10),
      arenaRest.tryGetBounties(),
    ]);
    this.meta = {
      leaderboardTop:
        lb?.leaderboard.map((e) => ({ name: e.name, elo: e.elo, kills: e.kills })) ?? this.meta.leaderboardTop,
      bounties: bounty?.entries.map((e) => ({ name: e.name, bounty: e.bounty ?? 0 })) ?? this.meta.bounties,
      fetchedAt: Date.now(),
    };
  }
}
