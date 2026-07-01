import type { FallbackBehavior, GridVec, LoadoutSelection, Weapon } from "./protocol";

/**
 * Internal domain types exchanged over the message bus between the real-time
 * Engine and the LLM Brain. These are intentionally compact: the Engine
 * publishes condensed snapshots, the Brain publishes condensed directives.
 */

export type Posture = "aggressive" | "balanced" | "defensive" | "retreat";

export type Objective =
  | "hunt_bounty"
  | "engage_weakest"
  | "control_center"
  | "farm_pickups"
  | "survive"
  | "free_for_all";

/**
 * The strategy directive: the Brain's slow, high-level guidance that the
 * Engine's fast reactive controller reads each tick. The Engine works fine
 * without one (sensible defaults); the directive only biases its behaviour.
 */
export interface Directive {
  /** Monotonic version so the Engine can detect freshness. */
  version: number;
  /** Wall-clock ms when produced. */
  ts: number;
  /** Which round this directive was computed for (Engine ignores stale rounds). */
  round: number;
  posture: Posture;
  objective: Objective;
  /** Preferred target bot_id, if the Brain wants a specific kill. */
  primaryTargetId: string | null;
  /** Bot ids to actively avoid (e.g. a much stronger opponent). */
  avoidTargetIds: string[];
  /** Retreat/heal when hp/max_hp drops below this fraction. */
  hpRetreatFraction: number;
  /** 0..1 — how eager to grab pickups vs. press the attack. */
  aggression: number;
  /** Free-text rationale, for logs/telemetry only. */
  reasoning: string;
  /** Which agent produced this (strategist | tactician | fallback). */
  source: string;
}

export const DEFAULT_DIRECTIVE: Directive = {
  version: 0,
  ts: 0,
  round: -1,
  posture: "balanced",
  objective: "free_for_all",
  primaryTargetId: null,
  avoidTargetIds: [],
  hpRetreatFraction: 0.25,
  aggression: 0.62,
  reasoning: "default deterministic policy",
  source: "fallback",
};

/**
 * Runtime-tunable behaviour policy: the knobs that used to be hardcoded
 * constants in the engine's behaviours. The LLM Tuner agent rewrites these live
 * (over the bus, mirrored to Redis KV) so the bot can be re-tuned WITHOUT a
 * restart — the deterministic controller reads the latest values every tick.
 */
export interface EnginePolicy {
  version: number;
  ts: number;
  /** 0..1 — how readily to spend the 30-tick dodge (low = hoard it). */
  dodgeEagerness: number;
  /** -3..+3 tiles added to a ranged weapon's preferred fighting distance. */
  kiteRangeBias: number;
  /** Grapple-close to a melee target when the gap exceeds range + this (tiles). */
  grappleCloseMinGap: number;
  /** Target-scoring weights. */
  targetLowHpWeight: number;
  targetCloseWeight: number;
  targetThreatAversion: number;
  /**
   * Score-point margin a challenger must beat the current target by before
   * selectTarget switches away from it. 0 disables debouncing (switch on any
   * improvement, however small — the old behaviour).
   */
  targetSwitchHysteresis: number;
  /**
   * Weight applied to matchups.ts's weapon matchup rating (-2..+2) when
   * scoring a candidate target: our_weapon vs their_weapon. 0 disables it
   * (matchup knowledge previously wasn't consulted by targeting at all).
   */
  targetMatchupWeight: number;
  /** Max tiles to detour for an uncontested pickup. */
  pickupDetourMax: number;
  /** Drift to the next zone centre when within this many tiles of the edge. */
  zoneEdgeMargin: number;
  /** Mine behaviour while being chased. */
  mineWhenChased: boolean;
  mineChaseRange: number;
  mineCooldownTicks: number;
  /** Engage only when the estimated trade advantage is at least this (-1..1). */
  minTradeAdvantage: number;
  /**
   * HP fraction below which a selected-but-unforced target's trade is
   * re-checked at all (minTradeAdvantage gates the actual bail decision).
   * Above this fraction we commit to whatever selectTarget picked without
   * ever consulting trade math — was a raw hardcoded 0.6 in controller.ts.
   */
  disengageHpThreshold: number;
  /**
   * How much the retreat HP threshold shifts with the live trade estimate against
   * the nearest threat: effective threshold = hpRetreatFraction - tradeAdvantage *
   * this. Retreat later vs. a favourable matchup, earlier vs. an unfavourable one.
   * 0 disables the scaling (static threshold, the old behaviour).
   */
  retreatTradeSensitivity: number;
  /**
   * When tacticalDisengage finds no safer tile nearby (cornered), try to actively
   * create separation — shove an adjacent threat back, or grapple away from a
   * ranged one — instead of silently falling through to fight a confirmed-bad trade.
   */
  disengageUseSeparation: boolean;
  /** Ticks ahead to lead a moving target when aiming/intercepting (0..8). */
  leadTicks: number;
  /** Tuner-controlled BASELINE aggression (0..1); the Tactician layers a delta on top. */
  aggression: number;
  /** Tuner-controlled baseline posture (used when no live tactical posture is set). */
  posture: Posture;
  /** Per-weapon tactic toggles the Tuner can flip. */
  bowAlwaysCharge: boolean; // bow: always spend a charged shot when ready
  daggerFlank: boolean; // daggers: reposition behind targets for the backstab bonus
  spearBraceWait: boolean; // spear: wait out a braced enemy instead of charging in
  staffGravityWell: boolean; // staff/grapple: deploy gravity wells to cluster enemies
  reasoning: string;
  source: string;
}

export const DEFAULT_POLICY: EnginePolicy = {
  version: 0,
  ts: 0,
  dodgeEagerness: 0.5,
  kiteRangeBias: 0,
  grappleCloseMinGap: 1.5,
  targetLowHpWeight: 60,
  targetCloseWeight: 2,
  targetThreatAversion: 30,
  targetSwitchHysteresis: 15,
  targetMatchupWeight: 12,
  pickupDetourMax: 6,
  zoneEdgeMargin: 5,
  mineWhenChased: true,
  mineChaseRange: 4,
  mineCooldownTicks: 15,
  minTradeAdvantage: -0.3,
  disengageHpThreshold: 0.6,
  retreatTradeSensitivity: 0.15,
  disengageUseSeparation: true,
  leadTicks: 3,
  aggression: 0.62,
  posture: "balanced",
  bowAlwaysCharge: true,
  daggerFlank: true,
  spearBraceWait: true,
  staffGravityWell: true,
  reasoning: "default tuning",
  source: "default",
};

const POSTURES: Posture[] = ["aggressive", "balanced", "defensive", "retreat"];
const asBool = (v: boolean | undefined, fallback: boolean): boolean =>
  typeof v === "boolean" ? v : fallback;

const clampNum = (v: number | undefined, lo: number, hi: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;

/**
 * Merge a (possibly partial, possibly LLM-produced) patch onto a base policy,
 * clamping every field to a safe range so a bad LLM value can never brick the
 * bot. Bumps the version so the Engine's newest-wins filter works.
 */
export function mergePolicy(base: EnginePolicy, patch: Partial<EnginePolicy>): EnginePolicy {
  return {
    version: base.version + 1,
    ts: Date.now(),
    dodgeEagerness: clampNum(patch.dodgeEagerness, 0, 1, base.dodgeEagerness),
    kiteRangeBias: clampNum(patch.kiteRangeBias, -3, 3, base.kiteRangeBias),
    grappleCloseMinGap: clampNum(patch.grappleCloseMinGap, 0.5, 8, base.grappleCloseMinGap),
    targetLowHpWeight: clampNum(patch.targetLowHpWeight, 0, 150, base.targetLowHpWeight),
    targetCloseWeight: clampNum(patch.targetCloseWeight, 0, 10, base.targetCloseWeight),
    targetThreatAversion: clampNum(patch.targetThreatAversion, 0, 120, base.targetThreatAversion),
    targetSwitchHysteresis: clampNum(patch.targetSwitchHysteresis, 0, 60, base.targetSwitchHysteresis),
    targetMatchupWeight: clampNum(patch.targetMatchupWeight, 0, 40, base.targetMatchupWeight),
    pickupDetourMax: clampNum(patch.pickupDetourMax, 0, 20, base.pickupDetourMax),
    zoneEdgeMargin: clampNum(patch.zoneEdgeMargin, 0, 20, base.zoneEdgeMargin),
    mineWhenChased:
      typeof patch.mineWhenChased === "boolean" ? patch.mineWhenChased : base.mineWhenChased,
    mineChaseRange: clampNum(patch.mineChaseRange, 1, 10, base.mineChaseRange),
    mineCooldownTicks: clampNum(patch.mineCooldownTicks, 5, 100, base.mineCooldownTicks),
    minTradeAdvantage: clampNum(patch.minTradeAdvantage, -1, 1, base.minTradeAdvantage),
    disengageHpThreshold: clampNum(patch.disengageHpThreshold, 0, 1, base.disengageHpThreshold),
    retreatTradeSensitivity: clampNum(patch.retreatTradeSensitivity, 0, 0.4, base.retreatTradeSensitivity),
    disengageUseSeparation: asBool(patch.disengageUseSeparation, base.disengageUseSeparation),
    leadTicks: clampNum(patch.leadTicks, 0, 8, base.leadTicks),
    aggression: clampNum(patch.aggression, 0, 1, base.aggression),
    posture: patch.posture && POSTURES.includes(patch.posture) ? patch.posture : base.posture,
    bowAlwaysCharge: asBool(patch.bowAlwaysCharge, base.bowAlwaysCharge),
    daggerFlank: asBool(patch.daggerFlank, base.daggerFlank),
    spearBraceWait: asBool(patch.spearBraceWait, base.spearBraceWait),
    staffGravityWell: asBool(patch.staffGravityWell, base.staffGravityWell),
    reasoning: typeof patch.reasoning === "string" ? patch.reasoning.slice(0, 300) : base.reasoning,
    source: typeof patch.source === "string" ? patch.source : "tuner",
  };
}

/**
 * Bot-to-bot coalition message, broadcast on the global bus by each of our
 * parallel bots (when BOT_COOP=true). Lets allies avoid friendly fire, focus a
 * shared target, and share enemy sightings beyond their own fog.
 */
export interface CoopMessage {
  ts: number;
  /** Our arena bot_id (so allies know which bot_ids are friendly). */
  botId: string;
  name: string;
  weapon: Weapon;
  pos: GridVec;
  hp: number;
  /** Enemies we currently see (never includes friendlies). */
  enemies: { id: string; hp: number; pos: GridVec }[];
  /** Our vote for the focus-fire target (lowest-HP enemy we see), or null. */
  focusVote: string | null;
}

/**
 * Squad role assigned to one of our bots by the Coordinator brain — mirrors
 * basic fireteam doctrine: someone tanks/holds the line, someone exploits
 * openings from the flank, someone hangs back and provides ranged support.
 */
export type CoopRole = "hold" | "flank" | "support";

/**
 * Coalition-wide tactical directive, produced by the (single, LLM-driven)
 * Coordinator brain from pooled squad + enemy intel and broadcast on the
 * GLOBAL bus so every one of our parallel bots' engines can read it. Purely
 * additive: engines fall back to their own local heuristic (lowest-HP focus,
 * no assigned role) when this is absent or stale.
 */
export interface CoopDirective {
  version: number;
  ts: number;
  /** Concentrate the whole squad's fire on this enemy bot_id, or null. */
  focusTargetId: string | null;
  /** botId -> assigned squad role. */
  roles: Record<string, CoopRole>;
  /** Call to regroup/fall back as a unit rather than fight scattered. */
  regroup: boolean;
  reasoning: string;
  source: string;
}

export const DEFAULT_COOP_DIRECTIVE: CoopDirective = {
  version: 0,
  ts: 0,
  focusTargetId: null,
  roles: {},
  regroup: false,
  reasoning: "",
  source: "none",
};

/** A chosen loadout plus rationale, produced by the loadout agent. */
export interface LoadoutPlan extends LoadoutSelection {
  reasoning: string;
  source: string;
}

/**
 * A condensed enemy view the Engine publishes for the Brain to reason about.
 * Strips per-tick noise the LLM doesn't need.
 */
export interface EnemySnapshot {
  id: string;
  name: string;
  weapon: Weapon;
  hp: number;
  maxHp: number;
  position: GridVec;
  distance: number;
  threatScore: number;
  hasLineOfSight: boolean;
  canAttack: boolean;
  isStunned: boolean;
  rearExposed: boolean;
}

/**
 * Condensed game snapshot published by the Engine ~1-2x/sec for the Brain.
 * Small on purpose — the LLM gets the gist, not the firehose.
 */
export type NearbyHazardType = "burn_field" | "hazard" | "gravity_well" | "mine" | "void";

export interface NearbyHazardSnapshot {
  type: NearbyHazardType;
  position: GridVec;
  distance: number;
  radius?: number;
  active?: boolean;
}

export interface LastSeenEnemySnapshot {
  botId: string;
  position: GridVec;
  age: number;
}

export interface NearbyTerrainSnapshot {
  type: "wall" | "void" | "water";
  position: GridVec;
  distance: number;
}

export interface GameSnapshot {
  ts: number;
  round: number;
  tick: number;
  roundModifier: string;
  self: {
    id: string;
    weapon: Weapon;
    hp: number;
    maxHp: number;
    position: GridVec;
    killStreak: number;
    roundKills: number;
    inSafeZone: boolean;
    distanceToZoneEdge: number;
    grappleCharges: number;
  };
  zone: {
    center: GridVec;
    radius: number;
    targetCenter: GridVec;
    targetRadius: number;
  };
  enemies: EnemySnapshot[];
  nearbyPickups: { type: string; position: GridVec; distance: number }[];
  nearbyHazards: NearbyHazardSnapshot[];
  nearbyTerrain: NearbyTerrainSnapshot[];
  lastSeenEnemies: LastSeenEnemySnapshot[];
  recentKills: { killer: string; victim: string; weapon: Weapon }[];
}

/** Round metadata published at round_start so the Brain can pick a loadout. */
export interface RoundContext {
  ts: number;
  round: number;
  roundModifier: string;
  roundModifierLabel: string;
  botsInRound: number;
  /** Snapshot of the public leaderboard top entries (best-effort). */
  leaderboardTop: { name: string; elo: number; kills: number }[];
  /** Current bounty board (best-effort). */
  bounties: { name: string; bounty: number }[];
  /** Our own lifetime stats (best-effort). */
  ourStats: {
    elo: number;
    kills: number;
    deaths: number;
    kd_ratio: number;
    best_streak: number;
    rounds_played: number;
    round_wins: number;
  } | null;
  /** How many bots are connected in the arena right now (best-effort). */
  arenaBotsConnected: number | null;
  /** Opponent weapons seen in the pre-round lobby (best-effort, may be empty). */
  lobbyWeapons: Partial<Record<Weapon, number>>;
  /** Constraints from the `connected` handshake. */
  constraints: {
    statBudget: number;
    statMin: number;
    statMax: number;
    availableWeapons: Weapon[];
  };
}

/** Request the Engine sends to the Brain asking for a loadout decision. */
export interface LoadoutRequest {
  ts: number;
  round: number;
  context: RoundContext;
  /** Deterministic fallback the Engine will use if the Brain doesn't answer in time. */
  fallback: LoadoutSelection;
}

export type { FallbackBehavior, LoadoutSelection };
