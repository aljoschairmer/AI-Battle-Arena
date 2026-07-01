# Phase 5 — Non-engine audit: Brain, arena transport, bus, shared, bootstrap

Scope: `src/brain/*`, `src/arena/*`, `src/bus/*`, `src/shared/*`, `src/config.ts`,
`src/main.ts`, plus the engine-side *consumers* of bus payloads (`engine/index.ts`,
`engine/gameState.ts`, `engine/coop.ts`). Combat behaviours (`engine/behaviors/*`,
`controller.ts`) were audited previously and are untouched here.

Every fix verified with `npm run typecheck` + `npm run smoke` (36 new assertions,
149 total, all green).

## Phase 1 — traced failure patterns, confirmed vs ruled out

| Check | Verdict | Evidence |
|---|---|---|
| WS reconnect reuses stale GameState against a new round | **CONFIRMED** (via gameState, not ws) | `applyRoundStart`/`applyConnected` never cleared `lastSeenEnemies`/`enemyVel`/`entities`; if the server tick counter resets per round, age-based expiry (`now - tick > 30`) can never reclaim old entries → phantom "recently seen" enemies at last round's coordinates |
| `ARENA_WS_AUTH=message` default in code | Ruled out | `config.ts:83` — default and any non-`"query"` value collapse to `message`; `query` reachable only by exact string |
| Token bucket bypassed by some send path | Ruled out | every outbound path goes through `send()`; only the auth frame uses `sendImmediate` (intentional, one frame per connection) |
| Token bucket refill under clock drift | **CONFIRMED** | `Date.now()` refill: an NTP step backwards stalls refill for the size of the step; at 10 actions/s the bucket (6) drains <1s and all actions drop → AFK kick |
| Burst exceeded before first refill | Ruled out | tokens float-capped at capacity; continuous elapsed-time refill |
| AFK: tick without an outbound action | Ruled out | `decide()` result sent every tick; the tick handler's catch path sends `idle` |
| Reconnect backoff bounded | Ruled out | exp backoff capped at 30s + jitter (`ws.ts:171-181`) |
| Server frames can spoof internal events | **CONFIRMED** | `onMessage` emitted *any* server-provided `type` string; `{"type":"close"}` would schedule a reconnect while the real socket is open (duplicate sockets/ticks) |
| REST blocking the WS loop | Ruled out | loadout REST capped at 1.5s with the fallback timer armed *before* the await; `refreshTerrain`/stat fetches are `void`-ed |
| Redis vs memory Bus semantics | **CONFIRMED divergence** | Redis KV expires (`EX 300`), memory KV never expired; Redis `subscribe` could fail, memory's can't |
| RedisBus subscribe failure | **CONFIRMED** | handler-set inserted into the map *before* awaiting SUBSCRIBE; on failure an empty set remains → all later `subscribe()` calls to that channel skip the wire SUBSCRIBE and silently never deliver |
| Bus scoping complete | Ruled out (in-process) | every engine/brain channel+key rides the per-bot `ScopedBus`; `arena:coop`/`arena:coop_directive` intentionally global and namespaced distinctly. **But** split deployments can mismatch scopes: scope count derives from `ARENA_API_KEYS` length, and a ROLE=brain process without those keys listens unscoped while engines publish `bot0:`… — silent total brain outage |
| Coop staleness checked where | Ruled out (engine side) | read-time TTLs in `Coalition.friendlyIds/focus/role/shouldRegroup` (8s/4s/12s), all consumers check. **CONFIRMED** on the coordinator side: `CoopCoordinator` judged member staleness by the *sender's* wall clock (`m.ts`) — cross-host clock skew makes members permanently stale or permanently fresh |
| LLM timeout actually aborts | Ruled out | `AbortController` cancels the fetch; no orphaned late response from a single attempt |
| Late response overwrites newer directive | **CONFIRMED** (different shape) | chat() retries once → up to ~2×timeout+250ms end-to-end; output applied against the *dispatch-time* snapshot with a version bump at apply time, so a late round-N tactic outranks round-N+1's strategist directive. No round guard existed on either side despite `Directive.round`'s doc claiming one |
| Fallback keeps last good directive | Ruled out | failed agent returns `null`; orchestrator publishes nothing; engine keeps the previous directive. Loadout falls back to the deterministic pick embedded in the request |
| Schema-valid but nonsensical outputs | Mostly ruled out | target ids sanitized against the dispatch snapshot; numerics clamped by `clampedNum`/`mergePolicy`; `hpRetreatFraction` is a 0-1 fraction so "above max HP" is unrepresentable. Residual gap (fixed): stale-round ids passing sanitize against an old snapshot |
| Tactician/Coordinator cadence timer-driven | Ruled out | `setInterval` floored at 800ms / 1000ms; per-snapshot path only stores `latest`. One in-flight call at a time (busy flags) |
| Strategist round skip | **CONFIRMED** (new) | `lastStrategyRound` was set before the busy-check, so a round starting while the previous strategist call was in flight *never* got a plan |
| mergePolicy applied on the consuming side | **CONFIRMED missing** | engine applied bus/KV policy objects verbatim (`controller.setPolicy(p)`); a raw KV write bypassed every clamp |
| Version-reset deafness | **CONFIRMED** | engine filters on `version <=` only; KV mirror expires after 300s, so a Brain restarted after expiry re-seeds at version 0 and a long-running engine ignores every subsequent directive/policy forever. Same for `Coalition`'s coop-directive filter |
| geometry/json edge cases | Ruled out | no division anywhere (`toUnitStep` uses `Math.sign`, zero-vector → `[0,0]`); `extractJson` throws only inside `Agent.run`'s catch; WS parse failures are caught and dropped |
| logger hot-path cost | Ruled out | pino level-gates before serialization; no large-object literals on disabled-level hot paths |

## Phase 3 — ranked findings

**Silent degradation (highest priority)**
1. **Version-reset deafness** — brain/coordinator restart after KV expiry (or Redis flush) resets the version counter; engine/coalition then discard every new directive/policy/coop-directive forever. Invisible: the bot keeps playing on week-old guidance.
2. **No stale-round guard** (documented but unimplemented) — late LLM responses cross round boundaries with a winning version number; targets/postures computed for a finished round override the live round's plan.
3. **RedisBus subscribe poisoning** — one transient failure at startup and a channel is dead for the process lifetime, no error after the first log line.
4. **Split-deployment scope mismatch** — ROLE=brain without the engine's `ARENA_API_KEYS` listens on unscoped channels; engines publish scoped. Bots fight brainless, nothing crashes.
5. **Cross-round GameState leakage** — phantom last-seen enemies + poisoned velocity estimates feed snapshots, pickup safety, and prediction after every round transition.
6. **Engine trusts unclamped policy from the wire/KV** — anything that can write Redis can set `dodgeEagerness: 99`.
7. **Strategist round skip** when the previous round's call is still in flight.
8. **Coordinator member TTL on sender clock** — cross-host skew disables (or ghosts) squad coordination.

**Crash/connection-loss**
9. **Redis down at boot crashed startup** (`getKV`/`subscribe` seeds unguarded) — contradicting the "workers will keep retrying" log line.
10. **Server frame `{"type":"close"}` spoofs lifecycle events** → reconnect storm with the real socket still open.
11. **TokenBucket wall-clock regression** → all sends dropped for the size of the NTP step → AFK kick.

**Cost/consistency (no correctness impact)**
12. Memory KV never expired (Redis does at 300s) — BUS=memory didn't validate BUS=redis restart behaviour.
13. `LLM_TIMEOUT_MS` typo → 0/negative would abort every call instantly (silent full fallback).
14. Reconnect replayed a stale `pendingPlan` from the previous connection instead of re-asking the Brain.

Cadence/cost was otherwise clean: Tactician ~2.5s and Coordinator ~3s are genuinely timer-driven; snapshots arriving 2×/s only refresh `latest`.

## Phase 4 — fixes

| # | Fix | Files |
|---|---|---|
| 1 | `isFresher` (version OR newer-ts) + `shouldApplyDirective` (freshness + round guard) — applied in the engine's directive listener, policy listener, and `Coalition`'s coop-directive listener | `types/internal.ts`, `engine/index.ts`, `engine/coop.ts` |
| 2 | Apply-time stale-output discard in the orchestrator (round changed mid-call ⇒ logged + dropped, for tactician and strategist); `lastStrategyRound` recorded only when a run actually starts | `brain/orchestrator.ts` |
| 3 | `sanitizePolicy` (built on the existing `mergePolicy` clamp table, version/ts/source preserved) applied on the engine's read side for both bus and KV-seeded policies | `types/internal.ts`, `engine/index.ts` |
| 4 | Per-round transient reset (`resetTransientObservations`) at `round_start` and `connected` | `engine/gameState.ts` |
| 5 | RedisBus: handler registered before wire-SUBSCRIBE; failed SUBSCRIBE retries with capped backoff instead of poisoning the channel or throwing (matches MemoryBus's can't-fail semantics); KV seeds wrapped so Redis-down boots degrade to defaults | `bus/redis.ts`, `engine/index.ts`, `brain/orchestrator.ts`, `brain/coopCoordinator.ts` |
| 6 | MemoryBus KV TTL = 300s to mirror Redis `EX 300` (identical Bus semantics, test-injectable) | `bus/memory.ts` |
| 7 | TokenBucket on `performance.now()` (monotonic), clock injectable for tests | `shared/ratelimit.ts` |
| 8 | Server-frame type whitelist before re-emit; rolling 1s outbound-rate debug counter | `arena/ws.ts` |
| 9 | Coordinator member TTL on local receipt time | `brain/coopCoordinator.ts` |
| 10 | `LLM_TIMEOUT_MS` floored at 1000ms; split-deployment scope-mismatch warning at startup; stale `pendingPlan` cleared on reconnect | `config.ts`, `main.ts`, `engine/index.ts` |

Degradation guarantees preserved: no Redis → memory bus unchanged; no OpenRouter key →
deterministic engine unchanged (`Agent.run` still returns null, orchestrator still keeps
the last good directive); a failed/slow agent still costs one decision window, never a
crash or a blank directive. No changes to `engine/behaviors/*` or `controller.ts`.

## Deliberately not "fixed"

- **MemoryBus microtask-deferred delivery**: a subscriber attached between `publish()` and
  the microtask flush receives the message in memory mode but not in Redis mode. All real
  call sites subscribe before publishing (main.ts starts the Brain first); matching Redis
  exactly would mean snapshotting the listener set at publish time for no observed benefit.
- **`PolicyPatchSchema` omits the Phase-4 knobs** (`targetSwitchHysteresis`,
  `disengageHpThreshold`, …): the Tuner can't move them, but `mergePolicy` clamps them if it
  ever does. Prompt + schema additions are a tuning decision, out of scope for a bug pass.
- **`applyRespawn` treats `RespawnMsg.position` (world units) as grid units**: wrong for
  ≤100ms until the next tick overwrites it; no decision consumes it in that window.
