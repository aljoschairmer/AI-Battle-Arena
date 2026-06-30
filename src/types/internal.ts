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
  hpRetreatFraction: 0.3,
  aggression: 0.6,
  reasoning: "default deterministic policy",
  source: "fallback",
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
