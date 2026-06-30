/**
 * Bus channel + key names. Single source of truth so Engine and Brain never
 * disagree about where messages flow.
 *
 * Flow:
 *   Engine --snapshot-->        Brain   (condensed game state, ~1-2x/sec)
 *   Engine --loadout_request--> Brain   (at round_start)
 *   Brain  --directive-->       Engine  (strategy guidance)
 *   Brain  --loadout_plan-->    Engine  (chosen weapon + stats)
 *
 * KV holds the "last value" of directive/loadout so a freshly (re)started peer
 * can pick up current state immediately instead of waiting for the next push.
 */
export const Channels = {
  snapshot: "arena:snapshot",
  loadoutRequest: "arena:loadout_request",
  directive: "arena:directive",
  loadoutPlan: "arena:loadout_plan",
} as const;

export const Keys = {
  currentDirective: "arena:kv:directive",
  currentLoadoutPlan: "arena:kv:loadout_plan",
} as const;

export type ChannelName = (typeof Channels)[keyof typeof Channels];
