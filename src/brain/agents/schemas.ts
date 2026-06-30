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
  reasoning: z.string().max(500).default(""),
});
export type LoadoutOutput = z.infer<typeof LoadoutOutputSchema>;

export const StrategyOutputSchema = z.object({
  posture: PostureEnum,
  objective: ObjectiveEnum,
  primaryTargetId: z.string().nullable().default(null),
  avoidTargetIds: z.array(z.string()).max(8).default([]),
  hpRetreatFraction: z.number().min(0).max(1).default(0.3),
  aggression: z.number().min(0).max(1).default(0.6),
  reasoning: z.string().max(500).default(""),
});
export type StrategyOutput = z.infer<typeof StrategyOutputSchema>;

export const TacticOutputSchema = z.object({
  posture: PostureEnum,
  primaryTargetId: z.string().nullable().default(null),
  avoidTargetIds: z.array(z.string()).max(8).default([]),
  hpRetreatFraction: z.number().min(0).max(1).default(0.3),
  aggression: z.number().min(0).max(1).default(0.6),
  reasoning: z.string().max(400).default(""),
});
export type TacticOutput = z.infer<typeof TacticOutputSchema>;

export const PostureEnumSimple = z.enum(["aggressive", "balanced", "defensive"]);

export const AnalystOutputSchema = z.object({
  lessons: z.array(z.string().max(200)).max(6).default([]),
  recommendedWeapon: WeaponEnum.nullable().default(null),
  recommendedWeaponReason: z.string().max(300).default(""),
  dangerousOpponents: z.array(z.string()).max(5).default([]),
  weakOpponents: z.array(z.string()).max(5).default([]),
  suggestedPosture: PostureEnumSimple.default("balanced"),
});
export type AnalystOutput = z.infer<typeof AnalystOutputSchema>;

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
  reasoning: z.string().max(300).default(""),
});
export type PolicyPatch = z.infer<typeof PolicyPatchSchema>;
