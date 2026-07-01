/**
 * Bus channel + key names. Single source of truth so Engine and Brain never
 * disagree about where messages flow.
 *
 * Flow:
 *   Engine --snapshot-->        Brain   (condensed game state, ~1-2x/sec)
 *   Engine --loadout_request--> Brain   (at round_start)
 *   Engine --round_outcome-->   Brain   (post-round telemetry for the Analyst)
 *   Brain  --directive-->       Engine  (strategy guidance)
 *   Brain  --loadout_plan-->    Engine  (chosen weapon + stats)
 *
 * KV holds the "last value" of directive/loadout/insights so a freshly
 * (re)started peer can pick up current state immediately.
 */
export const Channels = {
  snapshot: "arena:snapshot",
  loadoutRequest: "arena:loadout_request",
  directive: "arena:directive",
  loadoutPlan: "arena:loadout_plan",
  roundOutcome: "arena:round_outcome",
  // Brain --policy--> Engine: live behaviour-tuning knobs the LLM rewrites
  // without a restart (newest version wins, mirrored to KV below).
  policy: "arena:policy",
  // Engine <--coop--> Engine: bot-to-bot coalition channel. Published on the
  // GLOBAL (unscoped) bus so all of our parallel bots hear each other.
  coop: "arena:coop",
  // Coordinator brain --coop_directive--> Engine: squad-wide focus-fire target
  // + role assignments (hold/flank/support). Also on the GLOBAL bus.
  coopDirective: "arena:coop_directive",
} as const;

export const Keys = {
  currentDirective: "arena:kv:directive",
  currentLoadoutPlan: "arena:kv:loadout_plan",
  learningInsights: "arena:kv:insights",
  currentPolicy: "arena:kv:policy",
  currentCoopDirective: "arena:kv:coop_directive",
} as const;

export type ChannelName = (typeof Channels)[keyof typeof Channels];
