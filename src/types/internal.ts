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
  /**
   * How many ticks a recently-seen (now out-of-fog) enemy position still
   * counts as "camping" a nearby pickup. grabPickup/seekPickup only ever run
   * with zero currently-visible enemies (selectTarget claims the tick
   * otherwise) — this is the one enemy-awareness signal actually reachable
   * there. 0 disables it (old behaviour: only currently-visible enemies
   * count, which in practice never fires while these run at all).
   */
  pickupStaleEnemyTicks: number;
  /** Drift to the next zone centre when within this many tiles of the edge. */
  zoneEdgeMargin: number;
  /**
   * Inside this many tiles of the edge, always drift regardless of combat —
   * zone damage compounds if ignored, so this floor is never skipped. Between
   * this and zoneEdgeMargin (the softer outer band), drift can defer to an
   * active, not-losing fight instead of interrupting it (measured: skipping
   * it outright cost nothing in HP but stretched fight duration ~50%,
   * see docs/audit/phase4-fixes.md). Clamped to zoneEdgeMargin at the call
   * site regardless of how the two are tuned independently.
   */
  zoneEdgeHardMargin: number;
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
  /**
   * Weight applied to combatMath.tradeAdvantage (-1..1) in target scoring —
   * was a raw hardcoded ×30 in targeting.ts, the last non-tunable weight in
   * scoreEnemy (every sibling weight was already an EnginePolicy field).
   */
  targetTradeWeight: number;
  /**
   * Flat score bonus for a target currently carrying an arena bounty (matched
   * by bot_id or name from the bounty board, fetched out-of-band at round
   * boundaries). Before this existed the hunt_bounty objective gave +15 to ANY
   * enemy — the engine literally could not tell who had the bounty.
   */
  targetBountyWeight: number;
  /**
   * Gank anticipation radius (tiles): enemies beyond the immediate 5-tile
   * attacker band but inside this radius count a faded share of their DPS in
   * tradeAdvantage when they're closing on us (or adjacent with their weapon
   * cooling). Before this, a third bot moved the trade number only once it was
   * ≤5 tiles AND can_attack — the classic 2v1 death read as a fine 1v1 until
   * we were surrounded.
   */
  gankRadius: number;
  /** 0..1 weight on anticipated (not-yet-in-range) ganker DPS. 0 disables. */
  gankApproachWeight: number;
  /**
   * Zone radius (tiles, using the shrink target while closing) at or below
   * which the endgame posture kicks in: tighter engage gating with multiple
   * enemies around, and center-holding instead of roaming when idle. Before
   * this the bot played the last 20 seconds exactly like the first 20.
   * 0 disables endgame behavior entirely.
   */
  endgameZoneRadius: number;
  /**
   * Extra trade advantage demanded before committing to a fight during the
   * endgame with 2+ enemies visible (added to minTradeAdvantage; the HP gate
   * is bypassed — even a healthy bot shouldn't take a marginal fight it can't
   * retreat from in a tiny zone that's about to be a 2v1).
   */
  endgameTradeCaution: number;
  /**
   * During the endgame, drift toward the shrink-target center whenever we're
   * further out than this fraction of the target radius (idle/no-target only).
   */
  endgameCenterHoldFraction: number;
  /**
   * Shove an adjacent enemy whose windup is telegraphed (charged_shot_ready /
   * bow_charge_level >= 2) — the 2-tick stun denies the charged shot. Skipped
   * when one normal hit would kill them instead.
   */
  shoveInterruptCharged: boolean;
  /**
   * When caught outside the safe zone with a grapple charge ready, anchor-pull
   * toward the zone instead of walking (12-tile yank vs 1-tile steps at
   * 3 HP/tick of zone damage). Verified absent before pass 3's deep dive: the
   * only route back in was walking.
   */
  grappleZoneEscape: boolean;
  /** Minimum tiles outside the zone edge before spending a grapple on escape. */
  grappleZoneEscapeMinDist: number;
  /**
   * Max CONSECUTIVE ticks the dagger in-range flank deferral may hold before
   * committing to a head-on attack. 0 = never defer (attack head-on always).
   * Bounds the pass-2 audit's confirmed orbit: an unterminated defer loop let
   * daggers circle a target indefinitely without ever attacking (0 damage
   * across every simulated daggers round — pass2-phase2-observations.md).
   */
  flankMaxDeferTicks: number;
  /**
   * Ranged weapons fire at an in-range chaser (instead of moving) on retreat
   * ticks where the weapon is ready — kite-and-fire. Without it the retreat
   * rung, which outranks engage, means a fleeing bow/staff never shoots at
   * all (confirmed dominant loss mode for ranged, pass2-phase2).
   */
  retreatFireWhileKiting: boolean;
  /**
   * Downtime self-care: below this HP fraction, quiet phases (no enemy in
   * fog) follow the server's PICKUP hints (health first) instead of chasing
   * the nearest bot hint into the next fight — top up before fighting again.
   * 0 disables (always hunt bots first, the old behaviour).
   */
  idleHealBelowHpFraction: number;
  /**
   * Downtime self-improvement: with nothing to fight, loot, or chase, head
   * for a nearby capture pad (+score, shield, damage buff) instead of aimless
   * patrol. false = old behaviour (patrol only).
   */
  idleCapturePads: boolean;
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
  targetSwitchHysteresis: 30,
  targetMatchupWeight: 12,
  pickupDetourMax: 6,
  pickupStaleEnemyTicks: 15,
  zoneEdgeMargin: 5,
  zoneEdgeHardMargin: 2,
  mineWhenChased: true,
  mineChaseRange: 4,
  mineCooldownTicks: 15,
  minTradeAdvantage: -0.3,
  disengageHpThreshold: 0.6,
  retreatTradeSensitivity: 0.15,
  disengageUseSeparation: true,
  leadTicks: 3,
  targetTradeWeight: 30,
  targetBountyWeight: 25,
  gankRadius: 9,
  gankApproachWeight: 0.5,
  // DEFAULT OFF after live A/B measurement (pass-3, 2026-07-02): arms with the
  // endgame posture enabled won 0/18 live rounds while endgame-off arms on the
  // SAME build won 7/22 (Fisher p≈0.01). Telemetry attributed the damage to
  // the center-hold displacing the hunting behaviors for much of each round
  // (this arena runs ~60s rounds with a fast shrink, so "endgame" covered far
  // more of the round than designed for). The knobs remain for the Tuner to
  // experiment with; the code path is smoke-covered with the knob enabled.
  endgameZoneRadius: 0,
  // 0.3 on top of the default minTradeAdvantage (-0.3) = demand at least an
  // EVEN trade before committing in an endgame crowd.
  endgameTradeCaution: 0.3,
  endgameCenterHoldFraction: 0.4,
  shoveInterruptCharged: true,
  grappleZoneEscape: true,
  grappleZoneEscapeMinDist: 4,
  flankMaxDeferTicks: 6,
  retreatFireWhileKiting: true,
  idleHealBelowHpFraction: 0.75,
  idleCapturePads: true,
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
    pickupStaleEnemyTicks: clampNum(patch.pickupStaleEnemyTicks, 0, 30, base.pickupStaleEnemyTicks),
    zoneEdgeMargin: clampNum(patch.zoneEdgeMargin, 0, 20, base.zoneEdgeMargin),
    zoneEdgeHardMargin: clampNum(patch.zoneEdgeHardMargin, 0, 20, base.zoneEdgeHardMargin),
    mineWhenChased:
      typeof patch.mineWhenChased === "boolean" ? patch.mineWhenChased : base.mineWhenChased,
    mineChaseRange: clampNum(patch.mineChaseRange, 1, 10, base.mineChaseRange),
    mineCooldownTicks: clampNum(patch.mineCooldownTicks, 5, 100, base.mineCooldownTicks),
    minTradeAdvantage: clampNum(patch.minTradeAdvantage, -1, 1, base.minTradeAdvantage),
    disengageHpThreshold: clampNum(patch.disengageHpThreshold, 0, 1, base.disengageHpThreshold),
    retreatTradeSensitivity: clampNum(patch.retreatTradeSensitivity, 0, 0.4, base.retreatTradeSensitivity),
    disengageUseSeparation: asBool(patch.disengageUseSeparation, base.disengageUseSeparation),
    leadTicks: clampNum(patch.leadTicks, 0, 8, base.leadTicks),
    targetTradeWeight: clampNum(patch.targetTradeWeight, 0, 100, base.targetTradeWeight),
    targetBountyWeight: clampNum(patch.targetBountyWeight, 0, 100, base.targetBountyWeight),
    gankRadius: clampNum(patch.gankRadius, 5, 16, base.gankRadius),
    gankApproachWeight: clampNum(patch.gankApproachWeight, 0, 1, base.gankApproachWeight),
    endgameZoneRadius: clampNum(patch.endgameZoneRadius, 0, 40, base.endgameZoneRadius),
    endgameTradeCaution: clampNum(patch.endgameTradeCaution, 0, 0.6, base.endgameTradeCaution),
    endgameCenterHoldFraction: clampNum(patch.endgameCenterHoldFraction, 0.1, 0.9, base.endgameCenterHoldFraction),
    shoveInterruptCharged: asBool(patch.shoveInterruptCharged, base.shoveInterruptCharged),
    grappleZoneEscape: asBool(patch.grappleZoneEscape, base.grappleZoneEscape),
    grappleZoneEscapeMinDist: clampNum(patch.grappleZoneEscapeMinDist, 2, 12, base.grappleZoneEscapeMinDist),
    flankMaxDeferTicks: clampNum(patch.flankMaxDeferTicks, 0, 30, base.flankMaxDeferTicks),
    retreatFireWhileKiting: asBool(patch.retreatFireWhileKiting, base.retreatFireWhileKiting),
    idleHealBelowHpFraction: clampNum(patch.idleHealBelowHpFraction, 0, 1, base.idleHealBelowHpFraction),
    idleCapturePads: asBool(patch.idleCapturePads, base.idleCapturePads),
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
 * Freshness check for versioned bus payloads (Directive / EnginePolicy /
 * CoopDirective). Version alone breaks when the producer restarts and its
 * counter resets (the Brain re-seeds from the KV mirror, but that mirror
 * expires after 5 minutes — a Brain restarted after expiry starts back at
 * version 1 and a long-running Engine holding version N would then ignore
 * every directive it ever publishes again). Wall-clock ts breaks the tie:
 * anything produced later than what we hold is accepted even if its version
 * counter regressed.
 */
export function isFresher(
  prev: { version: number; ts: number },
  next: { version: number; ts: number },
): boolean {
  return next.version > prev.version || next.ts > prev.ts;
}

/**
 * Should the Engine apply this directive? Combines the freshness check with
 * the round guard that Directive.round documents ("Engine ignores stale
 * rounds") — an LLM response computed against a previous round's snapshot
 * (agent latency can exceed a round transition) must not override the current
 * round's guidance. round < 0 on either side means "round-agnostic" (defaults,
 * pre-round directives, or an engine that hasn't seen round_start yet).
 */
export function shouldApplyDirective(
  prev: { version: number; ts: number },
  d: Directive,
  currentRound: number,
): boolean {
  if (!d || typeof d.version !== "number" || typeof d.ts !== "number") return false;
  if (!isFresher(prev, d)) return false;
  if (typeof d.round === "number" && d.round >= 0 && currentRound >= 0 && d.round < currentRound) {
    return false;
  }
  return true;
}

/**
 * Parse operator-provided EnginePolicy overrides (ENGINE_POLICY_OVERRIDES env,
 * a JSON object of policy fields). The A/B mechanism for live experiments:
 * run two bots (or two batches) on the SAME build with different knob values
 * and a POLICY_VARIANT tag each, so infra conditions hit both sides equally.
 * Values ride mergePolicy's clamp table like every other policy source; junk
 * input returns null (startup warns and continues on defaults — an override
 * must never brick the bot).
 */
export function parsePolicyOverrides(raw: string | undefined): Partial<EnginePolicy> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Partial<EnginePolicy>;
  } catch {
    return null;
  }
}

/**
 * Re-clamp a policy object read off the bus/KV on the CONSUMING side. The
 * Brain clamps before publishing, but the KV mirror is writable by anything
 * that can reach Redis, and an older/buggy peer may publish unclamped values —
 * the Engine never trusts the wire. Built on mergePolicy so there is exactly
 * one clamp table; version/ts/source are preserved (this is validation of an
 * existing revision, not a new one).
 */
export function sanitizePolicy(raw: EnginePolicy): EnginePolicy {
  const merged = mergePolicy(DEFAULT_POLICY, raw);
  return {
    ...merged,
    version: typeof raw.version === "number" && Number.isFinite(raw.version) ? raw.version : 0,
    ts: typeof raw.ts === "number" && Number.isFinite(raw.ts) ? raw.ts : 0,
    source: typeof raw.source === "string" ? raw.source : "unknown",
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
  /**
   * Tiles where WE have live mines planted. The server hides mines from
   * everyone but their owner — including coalition allies — so without this
   * broadcast teammates walk blind into each other's minefields (observed
   * live as two coalition kills in the pass-3 prod run). Optional for
   * backward compatibility with older peers.
   */
  mines?: GridVec[];
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
  /** Current bounty board (best-effort). botId when the API provides it. */
  bounties: { name: string; bounty: number; botId?: string | null }[];
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
  /**
   * This bot's position in our own coalition fleet (0-based) and the fleet
   * size — null/1 for a lone bot. Drafting inputs: N bots drafting from
   * identical information converge on identical weapons (observed live: the
   * whole fleet opening daggers every round), so the Loadout agent uses the
   * index to assign complementary archetypes.
   */
  fleetIndex: number | null;
  fleetSize: number;
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
