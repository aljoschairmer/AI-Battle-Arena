# Pass 4 — Live API surface audit (arena.angel-serv.com)

**Date:** 2026-07-02 · **Method:** every REST endpoint fetched live (including
authenticated ones, via a throwaway key generated and revoked for this audit),
site frontend JS decompiled for its endpoint usage, and both WebSocket feeds
captured raw (`/ws/bot` for ~120 s incl. a `round_start` + live ticks;
`/ws/spectator` for ~35 s). Every field observed on the wire was diffed against
`src/types/protocol.ts` and its actual consumption in the engine/brain.

## Endpoint inventory (complete)

| Endpoint | Documented | We call it | Verdict |
| --- | --- | --- | --- |
| `POST /api/v1/keys/generate` | yes | `rest.generateKey` | ✅ works (201) |
| `DELETE /api/v1/keys/revoke` | yes | `rest.revokeKey` | ✅ verified live (200, key 401s afterwards) |
| `PUT /api/v1/bot/config` | yes | `rest.putConfig` | ✅ our nested `default_loadout` shape is accepted and stored (flat `default_weapon`/`default_stats` fields are what the server *echoes*, but sending them flat is **ignored** — our shape is the right one) |
| `GET /api/v1/bot/stats` | yes | `rest.getBotStats` | ✅ works; response has 8 fields our type drops (below) |
| `GET /api/v1/bot/live` | yes | `rest.getBotLive` — **never called** | ⚠️ our `BotLiveState` type is wrong AND the endpoint is dead code (below) |
| `GET /api/v1/health` | yes | `rest.getHealth` | ✅ |
| `GET /api/v1/arena/status` | yes | `rest.getStatus` | ✅ all 7 fields typed |
| `GET /api/v1/arena/map` | yes | `rest.getMap` | ⚠️ we consume `terrain` only; live response also carries `capture_pads`, `teleport_pads`, `hazard_zones`, `legend`, `width/height/cell_size` (below) |
| `GET /api/v1/leaderboard` | yes | `rest.getLeaderboard` | ⚠️ `period=24h/7d/1h` returns **empty `entries`** live (server-side quirk); `sort=kd_ratio` returns the same order as `kills`. We only ever call `sort=elo` with no period, so nothing breaks today |
| `GET /api/v1/bounties` | yes | `rest.getBounties` | ⚠️ works but board was empty **while a live bounty target existed on ticks** — REST board ≠ tick beacon (finding 2) |
| `GET /api/v1/weapon-stats` | dashboard-only | `rest.getWeaponStats` | ✅ works; live entries have ~40 fields, we type/use 8 (tier, meta_score, balance_direction…). Untyped extras that could sharpen loadout picks: `recent_form`, `recent_confidence`, `hit_rate`, `damage_per_hit`, `history[50]` |
| `GET /api/v1/bot-setup` | dashboard-only | not called (transcribed into `docs/arena-spec.md`) | ✅ doc matches; two spec-side staleness notes below |
| `WS /ws/bot` | yes | `ArenaSocket` | ✅ works; several tick fields unparsed (finding 1–4) |
| `WS /ws/spectator` | yes | **not used at all** | 💡 biggest untapped source (finding 6) |

No other endpoints exist in the frontend bundles (`app.js`, `dashboard`,
`key-generator.js`, `leaderboard.js`, `spectator-ws.js`, renderer modules were
all grepped). No OpenAPI/docs routes are exposed (`/openapi.json`, `/docs`,
etc. all 404).

---

## Findings — broken things

### 1. Hazard zones are invisible to the engine (real damage bug)

Live ticks send pulsing hazard rectangles as `type: "hazard_zone"`:

```json
{"type":"hazard_zone","position":[35,40],"width":2,"height":2,
 "active":true,"on_ticks":30,"off_ticks":20,"tick_counter":18,"damage_per_tick":3}
```

`NearbyHazard` in `src/types/protocol.ts:220` only admits
`"hazard" | "gravity_well" | "mine" | "void"` — the server never sends
`"hazard"`; it sends `"hazard_zone"`. So `GameState.hazardTiles()`
(`src/engine/gameState.ts:330`) drops every one of them, `isSafeStep()` happily
steps into active zones, and nothing in pathfinding avoids terrain `'H'` cells
either (`isPassable` blocks only `'#'`/`'V'`). Net effect: the bot walks
through active hazard zones at 3 HP/tick — same damage rate as being outside
the zone — and the survival behavior never sees it coming. During
`hazard_storm` rounds this is worse. Also note they're **rectangles**
(`width`×`height` from `position`), not single tiles, and they **pulse**
(`active`/`tick_counter`/`on_ticks`/`off_ticks` lets you time safe crossings).

**Fix:** add `"hazard_zone"` (with `width/height/active/...`) to the entity
union, expand `hazardTiles()` to the full rectangle when `active` (or predicted
active on arrival), and optionally treat inactive zones as free real estate.

### 2. Bounty targeting reads the wrong source — the live beacon is ignored

Every tick carries a **global, fog-exempt bounty beacon** — twice:

- top-level `tick.bounty_target` (bot_id string), and
- a `nearby_entities` entry `{"type":"bounty_target","bot_id":…,"name":"Juggernaut","position":[88,31]}`
  — delivered even when the target is 77 tiles away, far outside fog.

Meanwhile `your_state.is_bounty_target` tells us when **we** are the hunted one
(everyone in the arena can see our live position!). None of these exist in
`protocol.ts`; `gs.isBountyTarget()` is fed only from `GET /api/v1/bounties` —
which was **empty** live at the very moment ticks broadcast an active target.
So the `targetBountyWeight` scoring in targeting is effectively dead, and we
never go defensive when we're the beacon.

**Fix:** parse the beacon (position → hunt option even unseen), parse
`your_state.is_bounty_target` (→ defensive posture / expect third parties),
keep REST as fallback only.

### 3. Gravity-well charges: we hand-count what the server already tells us

`your_state.gravity_well_charge` is on every live tick. The comment block at
`src/engine/gameState.ts:103-109` asserts this is "never echoed in SelfState"
and maintains optimistic bookkeeping (`noteIssuedAction` ±1). That assumption
is now false — and the hand count drifts whenever a `use_item` is issued but
rejected (rate-limit drop, out-of-range) or a pickup auto-collects. Same story
for `mine_count` (server echoes it; `Controller.minesPlacedThisRound` is the
hand-rolled twin and resets only on round start — a mid-round reconnect
desyncs it).

**Fix:** read `gravity_well_charge` and `mine_count` off `your_state`; keep the
local counters only as fallback.

### 4. `sudden_death` flag is sent every tick — we infer it never

`tick.sudden_death: bool` (also in the spectator feed). The bot-setup spec says
random tiles become instant-death void at min zone radius ("Keep moving!").
The engine has zero handling — no field parsed, no behavior change. Void tiles
presumably appear as terrain/`void` entities only if re-fetched, and we don't
re-fetch the map mid-round.

**Fix:** parse the flag; when true, raise movement cadence (never idle/brace),
and consider re-fetching `/arena/map` to pick up new `V` tiles.

### 5. `BotLiveState` type doesn't match the real `/bot/live` at all (dead code today)

Live response (offline): `{bot_id, name, online:false, message}`. Online (per
the dashboard's own consumer): `online, is_alive, phase, hp, max_hp,
action_counts{...}, round_kills, round_deaths, round_damage_dealt,
round_damage_taken, accuracy, round_pickups, round_distance, kill_streak`.
Our type says `in_game, position, weapon, ...` — nearly none of that exists.
Harmless only because `getBotLive()` has zero call sites. Either fix the type
(the `action_counts` histogram is a nice self-check that our intended actions
match what the server registered) or delete the method.

---

## Findings — missing features (data we receive and drop)

### 6. `/ws/spectator` — full global state, unused

One `arena_state` frame every tick (~17.5 KB), no auth, containing **all** bots
(position, hp, weapon, `target_id` — who is attacking whom, cooldowns, charges),
**all landmines** (position, owner, armed — mines are supposed to be invisible
to enemies in bot fog!), all pickups, capture/teleport/hazard state, kill feed,
`sudden_death`, `waiting_bots`. It is the fog-of-war bypass the arena hands out
for free. The Brain (which is async and off the hot path by design) could
subscribe and publish a strategic overlay (enemy positions/aggro graph/mine
map) via Redis without touching engine latency. Nothing in `src/` references
it today.

### 7. Capture pads: we know the tile, ignore the state machine

Tick entities of `type:"capture_pad"` carry `progress_ticks/capture_ticks,
owner_id, capturing_bot_id, is_contested, contender_count, is_ready,
cooldown_remaining_ticks, next_control_pulse_ticks, radius` — the whole
objective state. `movement.ts` only steers to the terrain `'C'` tile via
`nearestCapturePad()`; it can't tell contested from free, ours from theirs, or
ready from cooling down, so "capture" behavior can happily squat a pad we
already own on cooldown. Same data is also in `/arena/map` (pre-round) and the
spectator feed.

### 8. Teleport pads: never used for travel, never avoided when armed

`/arena/map` gives all 3 linked pairs (`linked_pad_id`) plus
`is_ready/cooldown_remaining_ticks`; tick entities include `teleport_pad` per
the spec (our capture window didn't pass near one). Uses we forgo: (a) rotation
shortcuts to zone/pickups/bounty target — especially in `teleport_surge`
rounds; (b) not standing on a ready pad by accident; (c) mining teleport exits
(the spec explicitly calls out "teleporter lanes" for mines). `isTeleportPad()`
exists in `gameState.ts` but has **no call sites**.

### 9. `/arena/map` extras beyond terrain

`refreshTerrain()` (`src/engine/index.ts:327`) keeps only `map.terrain`.
The same response carries `capture_pads`, `teleport_pads`, `hazard_zones`
(with pulse config), `legend`, `width/height/cell_size` — i.e. the entire
static objective layout, available **during intermission before round start**
(the map is pre-generated). One fetch would seed hazard rectangles (fixing
finding 1 even without entity parsing), teleport links, and the pad location
without waiting to stumble into fog range.

### 10. Enemy `target_id` and `bow_charge_ticks` on nearby bots

Live bot entities include `target_id` (who that enemy is currently locked on)
and `bow_charge_ticks`. `NearbyBot` types neither. `target_id` is the cheap
third-party detector: "two enemies target each other → let them trade; someone
targets me → pre-dodge/kite". The threat field currently guesses this from
distance/facing.

### 11. Tick-level `round_modifier` and `round_tick`

Ticks carry `round_modifier` (we only capture it from `round_start` — a bot
that (re)connects mid-round has `gs.roundModifier === ""` until the next round)
and `round_tick` (round-relative tick; we derive round age indirectly).
One-line parses.

### 12. `your_state.relay_battery_active/relay_battery_ticks`

Echoed live (relay_battery pickup: +1 capture progress/tick). Untyped, unread —
capture behavior can't prioritize pad rushes while the buff is running.

### 13. `/bot/stats` drops 8 real fields

Live: `assists, damage_taken, current_streak, rank, pickups_collected,
distance_traveled, time_alive_seconds, longest_life_secs` — all absent from
`BotStats`. The Analyst/Tuner currently judge rounds without damage_taken
(defense efficiency) or time_alive (survival trend), both of which they'd use.

### 14. Leaderboard entries: `avatar_color`, `best_streak`, `damage_dealt` untyped

Also: our optional `kill_streak`/`kd_ratio` fields **don't exist** on the wire
(it's `best_streak`; `kd_ratio` is nowhere in the live payload — computing it
client-side is fine). `sort=streak` works; `sort=kd_ratio` silently falls back
to a kills-like order; `period` ≠ all_time returns empty entries (server bug —
don't build anything on `period`).

---

## Spec/doc corrections (verified live)

- **`?key=` WS auth works now.** `protocol.ts:322` and `ws.ts` describe the
  query-param upgrade as broken server-side (HTTP 200 instead of 101). Live
  today it upgrades and authenticates fine. Message-auth also still works, so
  no change needed — but the "broken server-side" claims are stale, and
  `ARENA_WS_AUTH=query` is a valid config again.
- **`territorial` and `hunter` fallbacks are genuinely valid.** bot-setup's
  `stats.fallback_behaviors` lists only aggressive/defensive/opportunistic, but
  the server *validates* this field — an invalid value returns
  `{"type":"error","message":"invalid fallback \"…\", using default \"defensive\""}` —
  and it accepted `territorial`/`hunter` without complaint. Our 5-value
  `FallbackBehavior` type and `loadout.ts` mapping are correct; the published
  spec list is incomplete.
- **Terrain water `'~'`:** bot-setup declares it **impassable**;
  `gameState.ts:29` comments it as "walkable, cosmetic" and `isPassable`
  blocks only `'#'`/`'V'`. Current live maps contain no `'~'` (legend is
  `# . C H T`), so it's latent — but if water ever ships, we'd path through
  walls-equivalent tiles. Trust the spec: block `'~'`.
- **`map_init` WS message is officially deprecated** ("no longer sent") — we
  already don't rely on it; correct.
- **`connected.last_loadout`** echoes the *bot/config default loadout*, not the
  previous session's `select_loadout` (verified across reconnects).

## Priority order (if/when we implement)

1. Finding 1 (hazard_zone) — we are provably taking avoidable damage every round.
2. Finding 2 (bounty beacon + is_bounty_target) — free global intel, both offense and defense.
3. Finding 9 (map extras at intermission) — cheapest single change, feeds 1/7/8.
4. Finding 4 (sudden_death) + finding 10 (target_id) — small parses, real behavior wins.
5. Finding 6 (spectator feed into the Brain) — biggest ceiling, most code.

## Raw evidence

Captured during this audit (not committed): full JSON of every REST response,
120 s of `/ws/bot` frames (connected/loadout_confirmed/lobby/round_start/29 tick
samples) and 35 s of `/ws/spectator` frames. Key excerpts are inlined above;
regenerate any of it with a throwaway key via `POST /api/v1/keys/generate`.
