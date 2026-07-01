import { z } from "zod";

/** Shared zod enums/objects for agent outputs. */

export const WeaponEnum = z.enum([
  "sword",
  "bow",
  "daggers",
  "shield",
  "spear",
  "staff",
  "grapple",
]);

export const PostureEnum = z.enum(["aggressive", "balanced", "defensive", "retreat"]);

export const ObjectiveEnum = z.enum([
  "hunt_bounty",
  "engage_weakest",
  "control_center",
  "farm_pickups",
  "survive",
  "free_for_all",
]);

export const FallbackBehaviorEnum = z.enum([
  "aggressive",
  "defensive",
  "opportunistic",
  "territorial",
  "hunter",
]);

// --- lenient coercers --------------------------------------------------------
// LLMs routinely overshoot a max length or a numeric bound. Rejecting the whole
// object over that (Zod's default) silently drops an otherwise-good decision —
// which is exactly the "agent output failed validation" bug. These helpers
// TRUNCATE / CLAMP instead of failing, so a cosmetic overflow never costs us a
// turn. Hard constraints (enums, required shape) are still enforced.

/** Free text: coerce to string and truncate to `max`; never rejects. */
const looseText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" ? v.slice(0, max) : v == null ? "" : String(v).slice(0, max)),
    z.string(),
  );

/** Array of short strings: clamp count + per-item length; never rejects. */
const looseStrArray = (maxItems: number, maxLen: number) =>
  z.preprocess(
    (v) =>
      Array.isArray(v) ? v.slice(0, maxItems).map((x) => String(x).slice(0, maxLen)) : [],
    z.array(z.string()),
  );

/** Number clamped to [lo, hi] with a fallback for non-numbers; never rejects. */
const clampedNum = (lo: number, hi: number, fallback: number) =>
  z.preprocess(
    (v) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback),
    z.number(),
  );

export const StatBlockSchema = z.object({
  hp: z.number(),
  speed: z.number(),
  attack: z.number(),
  defense: z.number(),
});

export const LoadoutOutputSchema = z.object({
  weapon: WeaponEnum,
  stats: StatBlockSchema,
  fallback_behavior: FallbackBehaviorEnum,
  reasoning: looseText(500),
});
export type LoadoutOutput = z.infer<typeof LoadoutOutputSchema>;

export const StrategyOutputSchema = z.object({
  posture: PostureEnum,
  objective: ObjectiveEnum,
  primaryTargetId: z.string().nullable().default(null),
  avoidTargetIds: looseStrArray(8, 100),
  hpRetreatFraction: clampedNum(0, 1, 0.3),
  aggression: clampedNum(0, 1, 0.6),
  reasoning: looseText(500),
});
export type StrategyOutput = z.infer<typeof StrategyOutputSchema>;

export const TacticOutputSchema = z.object({
  posture: PostureEnum,
  primaryTargetId: z.string().nullable().default(null),
  avoidTargetIds: looseStrArray(8, 100),
  hpRetreatFraction: clampedNum(0, 1, 0.3),
  aggression: clampedNum(0, 1, 0.6),
  reasoning: looseText(400),
});
export type TacticOutput = z.infer<typeof TacticOutputSchema>;

export const PostureEnumSimple = z.enum(["aggressive", "balanced", "defensive"]);

export const AnalystOutputSchema = z.object({
  lessons: looseStrArray(6, 200),
  recommendedWeapon: WeaponEnum.nullable().default(null),
  recommendedWeaponReason: looseText(300),
  dangerousOpponents: looseStrArray(5, 100),
  weakOpponents: looseStrArray(5, 100),
  suggestedPosture: PostureEnumSimple.default("balanced"),
});
export type AnalystOutput = z.infer<typeof AnalystOutputSchema>;

export const CoopRoleEnum = z.enum(["hold", "flank", "support"]);

/**
 * Coordinator brain output — squad-wide military-tactics call: who to focus,
 * who tanks the front (hold), who exploits the flank, who hangs back on
 * ranged support, and whether the squad should regroup instead of fighting
 * scattered. `roles` keys are arena bot_ids; unknown/stale ids are dropped by
 * the coordinator before publishing.
 */
export const CoordinatorOutputSchema = z.object({
  focusTargetId: z.string().nullable().default(null),
  roles: z.record(z.string(), CoopRoleEnum).default({}),
  regroup: z.boolean().default(false),
  reasoning: looseText(400),
});
export type CoordinatorOutput = z.infer<typeof CoordinatorOutputSchema>;

/**
 * A partial patch of the engine's tuning policy produced by the Tuner agent.
 * Every field is optional (omitted = leave unchanged); values are clamped by
 * mergePolicy() so a bad number can never brick the bot.
 */
export const PolicyPatchSchema = z.object({
  dodgeEagerness: z.number().optional(),
  kiteRangeBias: z.number().optional(),
  grappleCloseMinGap: z.number().optional(),
  targetLowHpWeight: z.number().optional(),
  targetCloseWeight: z.number().optional(),
  targetThreatAversion: z.number().optional(),
  pickupDetourMax: z.number().optional(),
  zoneEdgeMargin: z.number().optional(),
  mineWhenChased: z.boolean().optional(),
  mineChaseRange: z.number().optional(),
  mineCooldownTicks: z.number().optional(),
  minTradeAdvantage: z.number().optional(),
  leadTicks: z.number().optional(),
  aggression: z.number().optional(),
  posture: PostureEnum.optional(),
  bowAlwaysCharge: z.boolean().optional(),
  daggerFlank: z.boolean().optional(),
  spearBraceWait: z.boolean().optional(),
  staffGravityWell: z.boolean().optional(),
  reasoning: looseText(300),
});
export type PolicyPatch = z.infer<typeof PolicyPatchSchema>;
