import type { SpectatorArenaState, SpectatorBot, Weapon } from "../types/protocol";

/** World units per grid tile (spectator frames use world coordinates). */
const CELL = 20;

/**
 * Behavioural profile of ONE arena bot, learned purely by watching the public
 * spectator feed — no fights against them required. Counters are cumulative
 * across every observed round; derived views (win rate, aggression, preferred
 * range) come from summarize().
 */
export interface ScoutProfile {
  name: string;
  /** Rounds this bot appeared in, per weapon (their draft tendencies). */
  weaponsSeen: Partial<Record<Weapon, number>>;
  roundsObserved: number;
  wins: number;
  kills: number;
  deaths: number;
  /** Sum over rounds of (ticks with a lock-on target / ticks alive). */
  aggressionSum: number;
  /** Distance to their current target, tiles (running sums). */
  rangeSum: number;
  rangeSamples: number;
  /** Sum over rounds of (ticks dodging / ticks alive). */
  dodgeSum: number;
  minesPlaced: number;
  /** Deaths while outside the safe zone (bad zone discipline). */
  zoneDeaths: number;
  lastSeenAt: number;
}

/** Per-round working state for one bot (reset every round). */
interface RoundAcc {
  name: string;
  weapon: Weapon;
  ticksAlive: number;
  ticksWithTarget: number;
  rangeSum: number;
  rangeSamples: number;
  ticksDodging: number;
  minesPlaced: number;
  lastMineCount: number | null;
  kills: number;
  died: boolean;
  diedOutsideZone: boolean;
  alive: boolean;
}

/** A compact, prompt-ready view of one scouted opponent. */
export interface ScoutSummary {
  name: string;
  primaryWeapon: Weapon | null;
  rounds: number;
  winRate: number;
  kd: number;
  /** 0..1 — fraction of alive time spent locked onto a target. */
  aggression: number;
  /** Average distance (tiles) they keep to their target — kiter vs brawler. */
  preferredRange: number | null;
  dodgeRate: number;
  minesPerRound: number;
  /** Fraction of deaths taken outside the safe zone. */
  zoneDeathRate: number;
}

/**
 * Stateful frame-stream aggregator. Feed it every spectator frame (10 Hz);
 * it detects round boundaries via the server's round_tick reset, accumulates
 * per-bot behaviour within the round, and folds finished rounds into
 * long-run ScoutProfiles. Pure TypeScript, no I/O — trivially testable.
 */
export class ScoutAggregator {
  private readonly profiles = new Map<string, ScoutProfile>();
  private round = new Map<string, RoundAcc>();
  private seenKills = new Set<string>();
  private prevRoundTick = -1;
  private roundsFinalized = 0;

  constructor(seed: ScoutProfile[] = [], private readonly now: () => number = Date.now) {
    for (const p of seed) this.profiles.set(p.name, p);
  }

  /** Rounds folded into the profiles since this process started. */
  get finalizedRounds(): number {
    return this.roundsFinalized;
  }

  ingest(frame: SpectatorArenaState): void {
    const roundTick = frame.round_tick ?? 0;
    // round_tick counts up within a round; a drop means the previous round
    // ended between frames — finalize it before ingesting the new one.
    if (roundTick < this.prevRoundTick) this.finalizeRound();
    this.prevRoundTick = roundTick;

    const bots = frame.bots ?? [];
    const byId = new Map<string, SpectatorBot>(bots.map((b) => [b.id, b]));
    const zone = frame.safe_zone;

    for (const b of bots) {
      if (!b.name) continue;
      let acc = this.round.get(b.name);
      if (!acc) {
        acc = {
          name: b.name,
          weapon: b.weapon,
          ticksAlive: 0,
          ticksWithTarget: 0,
          rangeSum: 0,
          rangeSamples: 0,
          ticksDodging: 0,
          minesPlaced: 0,
          lastMineCount: null,
          kills: 0,
          died: false,
          diedOutsideZone: false,
          alive: b.is_alive,
        };
        this.round.set(b.name, acc);
      }
      acc.weapon = b.weapon;

      // Death = alive -> dead transition (respawns flip it back; each
      // transition counts, matching how the arena scores deaths).
      if (acc.alive && !b.is_alive) {
        acc.died = true;
        if (zone) {
          const d = Math.hypot(b.position[0] - zone.center[0], b.position[1] - zone.center[1]);
          if (d > zone.radius) acc.diedOutsideZone = true;
        }
      }
      acc.alive = b.is_alive;
      if (!b.is_alive) continue;

      acc.ticksAlive++;
      if (b.is_dodging) acc.ticksDodging++;
      if (b.target_id) {
        acc.ticksWithTarget++;
        const t = byId.get(b.target_id);
        if (t?.is_alive) {
          acc.rangeSum += Math.hypot(b.position[0] - t.position[0], b.position[1] - t.position[1]) / CELL;
          acc.rangeSamples++;
        }
      }
      // mine_count = charges REMAINING; a decrease means one went into the
      // ground. Increases (pickups/round reset) just move the baseline.
      if (acc.lastMineCount !== null && b.mine_count < acc.lastMineCount) {
        acc.minesPlaced += acc.lastMineCount - b.mine_count;
      }
      acc.lastMineCount = b.mine_count;
    }

    // Kill feed entries repeat across frames — dedupe on (killer,victim,tick).
    for (const k of frame.kill_feed ?? []) {
      const key = `${k.killer}|${k.victim}|${k.tick}`;
      if (this.seenKills.has(key)) continue;
      this.seenKills.add(key);
      const killer = this.round.get(k.killer);
      if (killer && k.killer !== k.victim) killer.kills++;
    }
  }

  /**
   * Fold the current round into the long-run profiles. Called automatically
   * on a round_tick reset; call manually on shutdown to keep a final partial
   * round. Rounds with fewer than 2 bots or under ~5s of observation are
   * discarded (lobby noise / partial connects).
   */
  finalizeRound(): void {
    const accs = [...this.round.values()];
    this.round = new Map();
    this.seenKills = new Set();
    if (accs.length < 2) return;
    const maxTicks = Math.max(...accs.map((a) => a.ticksAlive));
    if (maxTicks < 50) return;

    // Winner: the sole survivor; with several still standing (timeout end /
    // feed cut), the top killer among the living — nobody on a tie.
    const alive = accs.filter((a) => a.alive);
    let winner: string | null = null;
    if (alive.length === 1) winner = alive[0]!.name;
    else if (alive.length > 1) {
      const sorted = [...alive].sort((a, b) => b.kills - a.kills);
      if (sorted[0]!.kills > (sorted[1]?.kills ?? 0)) winner = sorted[0]!.name;
    }

    for (const a of accs) {
      if (a.ticksAlive < 20) continue; // barely appeared — not evidence
      const p = this.profiles.get(a.name) ?? emptyProfile(a.name);
      p.weaponsSeen[a.weapon] = (p.weaponsSeen[a.weapon] ?? 0) + 1;
      p.roundsObserved++;
      if (a.name === winner) p.wins++;
      p.kills += a.kills;
      if (a.died) p.deaths++;
      if (a.diedOutsideZone) p.zoneDeaths++;
      p.aggressionSum += a.ticksWithTarget / a.ticksAlive;
      p.rangeSum += a.rangeSum;
      p.rangeSamples += a.rangeSamples;
      p.dodgeSum += a.ticksDodging / a.ticksAlive;
      p.minesPlaced += a.minesPlaced;
      p.lastSeenAt = this.now();
      this.profiles.set(a.name, p);
    }
    this.roundsFinalized++;
  }

  /** Cumulative profiles (persistable as-is). */
  snapshot(): ScoutProfile[] {
    return [...this.profiles.values()].sort((a, b) => b.roundsObserved - a.roundsObserved);
  }

  /** Prompt-ready derived view of the most-observed opponents. */
  summarize(limit = 12, minRounds = 3): ScoutSummary[] {
    return this.snapshot()
      .filter((p) => p.roundsObserved >= minRounds)
      .slice(0, limit)
      .map((p) => ({
        name: p.name,
        primaryWeapon: primaryWeapon(p),
        rounds: p.roundsObserved,
        winRate: round2(p.wins / p.roundsObserved),
        kd: round2(p.kills / Math.max(1, p.deaths)),
        aggression: round2(p.aggressionSum / p.roundsObserved),
        preferredRange: p.rangeSamples > 0 ? round2(p.rangeSum / p.rangeSamples) : null,
        dodgeRate: round2(p.dodgeSum / p.roundsObserved),
        minesPerRound: round2(p.minesPlaced / p.roundsObserved),
        zoneDeathRate: p.deaths > 0 ? round2(p.zoneDeaths / p.deaths) : 0,
      }));
  }
}

function emptyProfile(name: string): ScoutProfile {
  return {
    name,
    weaponsSeen: {},
    roundsObserved: 0,
    wins: 0,
    kills: 0,
    deaths: 0,
    aggressionSum: 0,
    rangeSum: 0,
    rangeSamples: 0,
    dodgeSum: 0,
    minesPlaced: 0,
    zoneDeaths: 0,
    lastSeenAt: 0,
  };
}

/**
 * Merge two independent sets of scout profiles (e.g. two sessions/containers
 * that each watched the arena for a while) into one, summing every counter
 * per bot name. Safe because ScoutProfile's fields are pure additive tallies
 * — even in the unlikely case both sources observed the SAME live rounds at
 * the same time (double-counting them), every counter inflates by roughly
 * the same factor, so derived ratios (win rate, K/D, aggression, dodge rate)
 * stay approximately correct; only the raw `roundsObserved`/confidence count
 * reads higher than it should. That's a far smaller cost than the
 * alternative (picking one source and discarding whatever the other
 * uniquely knew about an opponent it saw more of, or a bot it saw at all).
 */
export function mergeScoutProfiles(a: ScoutProfile[], b: ScoutProfile[]): ScoutProfile[] {
  const byName = new Map<string, ScoutProfile>();
  for (const p of a) byName.set(p.name, { ...p, weaponsSeen: { ...p.weaponsSeen } });
  for (const p of b) {
    const existing = byName.get(p.name);
    if (!existing) {
      byName.set(p.name, { ...p, weaponsSeen: { ...p.weaponsSeen } });
      continue;
    }
    const weaponsSeen: Partial<Record<Weapon, number>> = { ...existing.weaponsSeen };
    for (const [w, c] of Object.entries(p.weaponsSeen) as [Weapon, number][]) {
      weaponsSeen[w] = (weaponsSeen[w] ?? 0) + c;
    }
    byName.set(p.name, {
      name: p.name,
      weaponsSeen,
      roundsObserved: existing.roundsObserved + p.roundsObserved,
      wins: existing.wins + p.wins,
      kills: existing.kills + p.kills,
      deaths: existing.deaths + p.deaths,
      aggressionSum: existing.aggressionSum + p.aggressionSum,
      rangeSum: existing.rangeSum + p.rangeSum,
      rangeSamples: existing.rangeSamples + p.rangeSamples,
      dodgeSum: existing.dodgeSum + p.dodgeSum,
      minesPlaced: existing.minesPlaced + p.minesPlaced,
      zoneDeaths: existing.zoneDeaths + p.zoneDeaths,
      lastSeenAt: Math.max(existing.lastSeenAt, p.lastSeenAt),
    });
  }
  return [...byName.values()].sort((x, y) => y.roundsObserved - x.roundsObserved);
}

function primaryWeapon(p: ScoutProfile): Weapon | null {
  let best: Weapon | null = null;
  let n = 0;
  for (const [w, c] of Object.entries(p.weaponsSeen) as [Weapon, number][]) {
    if (c > n) {
      n = c;
      best = w;
    }
  }
  return best;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
