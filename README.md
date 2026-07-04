# AI Battle Arena — Multi-Agent TypeScript Bot

> ## ⚠️ Disclaimer
> This project was **built and programmed entirely by AI agents** (Claude Code) —
> architecture, engine, brain, tests, audits, and even this disclaimer. Not a single
> line was written by hand. Which makes it, officially, **the worst code I have ever
> coded** — I didn't code any of it. Read, run, and judge accordingly.

A high-performance bot for [**AI Battle Arena**](https://arena.angel-serv.com/) that pairs a
deterministic, sub-millisecond combat **Engine** with a multi-agent **LLM Brain** (via
[OpenRouter](https://openrouter.ai)), decoupled over a **Redis** message bus.

> **The core idea:** the arena ticks at **10 Hz (100 ms/tick)**. An LLM can't answer in 100 ms,
> so LLMs must **never** sit in the control loop. Instead a fast reactive controller fights every
> tick, while LLM agents set high-level *strategy* asynchronously. Redis is the seam between the
> two so model latency can never stall combat.

---

## What is AI Battle Arena?

A competitive autonomous-combat sandbox. You connect a bot over WebSocket and it fights live,
multi-bot, free-for-all rounds. Key facts discovered from the live API:

| Property | Value |
| --- | --- |
| Arena | 100×100 tile grid (2000×2000 world units, 20u cells) |
| Tick rate | **10 Hz** (100 ms/tick) |
| Round length | up to 300 s, with a shrinking safe zone (3 HP/tick outside) — in practice this
arena's rounds run fast (often ~60 s to a kill) |
| Visibility | fog of war, 7-tile radius |
| Weapons | sword, bow, daggers, shield, spear, staff, grapple |
| Loadout | pick 1 weapon + spend **20** stat points across hp/speed/attack/defense (1–10 each) |
| Universal kit | 2 grapple charges + up to 3 mines + shove, per round |
| Actions | move, move_to, attack (+charged), dodge, shove, place_mine, grapple, use_gravity_well, use_item, idle |
| Scoring | ELO (start 1000), kills/deaths, streaks, bounties |
| Auth | `X-Arena-Key` header / `?key=` WS query param; keys are free (`POST /api/v1/keys/generate`) |

**Connect flow:** generate key → open `wss://arena.angel-serv.com/ws/bot?key=…` → receive
`connected` → send `select_loadout` within ~10 s → `lobby` → `round_start` → `tick` ×N (you reply
with one `action` per tick) → `round_end` → repeat. Rate limit: 25 msg/s; AFK timeout ~3 s.

### Stat system (reverse-engineered from the site's Stat Simulator)

The public **Simulator** tab exposes the exact derived-stat formulas. We encoded them in
[`src/shared/derived.ts`](src/shared/derived.ts) — verified to reproduce every number the
simulator prints (max HP 150, speed 5.5, atk mult 1.5×, def red 15%, effective HP 176 for a
5/5/5/5 sword, plus its whole DPS/hits-to-kill table):

| Derived | Formula | Range |
| --- | --- | --- |
| Max HP | `100 + 10·hp` | 110–200 |
| Speed | `3 + 0.5·speed` tiles/s | 3.5–8.0 |
| Attack mult | `1 + 0.1·attack` | 1.1–2.0× |
| Defense reduction | `0.03·defense` (capped 30%) | 3–30% |
| **Effective HP** | `max_hp / (1 − def_red)` | — |
| Damage/hit | `weapon_base · atk_mult · (1 − enemy_def_red)` | — |

**What this tells us about builds.** Because *effective HP* already fully credits defense, and
defense only buys 3%/point (max 30%), it's the **weakest** stat per point. Fight power
(≈ `effective_hp × attack_mult`) is maximized by splitting the budget ~evenly between **HP and
attack** over a per-weapon mobility floor and keeping defense low — the flat 5/5/5/5 the site
recommends as a "starter" leaves ~9% fight power on the table. So our default builds
([`optimizeBuild`](src/shared/derived.ts) brute-forces the fight-power-optimal legal spread) are
deliberately more aggressive, e.g. sword `hp7 spd5 atk6 def2` (eHP 181, 1.6× atk) instead of a
defensive spread. The LLM loadout agent gets these formulas and the fallback's real eHP/DPS in
its prompt, so its picks are grounded in the same math.

**Counter-picking.** The dashboard's Strategy tab publishes a weapon-matchup matrix (e.g. daggers
hard-counter bow & staff; staff hard-counters shield). It's encoded in
[`src/engine/matchups.ts`](src/engine/matchups.ts): both the deterministic fallback and the LLM
agent score each weapon's count-weighted matchup edge against the weapons seen in the lobby, and
the Loadout agent additionally weighs known counter-picks against **specific opponents it has
seen in prior rounds** (see [Round-history & opponent memory](#round-history--opponent-memory)
below). A fuller dump of the canonical spec (actions, arena systems, pickups, formulas, the
matrix) lives in [`docs/arena-spec.md`](docs/arena-spec.md), sourced from `GET /api/v1/bot-setup`.

---

## Architecture

```
                         ┌──────────────────────── Redis ────────────────────────┐
                         │   pub/sub channels  +  KV "last value" mirror          │
                         └───────▲───────────────▲───────────────┬───────────────┘
        snapshot (2/s) ─────────┘                │               │
        loadout_request ────────────────────────┘               │ directive / loadout_plan
                                                                 ▼
┌───────────────────────────────────┐                 ┌───────────────────────────────────┐
│             ENGINE                │                 │              BRAIN                 │
│   (deterministic, 10 Hz, <1 ms)   │                 │     (LLM agents, async, slow)      │
│                                   │                 │                                    │
│  WS ◄──► arena                    │                 │  Orchestrator                      │
│  GameState (world model)          │   directive     │   ├─ Strategist  (per round)       │
│  Controller ── priority pipeline  │ ◄────────────── │   ├─ Tactician   (every ~2.5 s)    │
│   1 survive zone/hazards          │                 │   ├─ Loadout     (per connect)     │
│   2 emergency dodge               │  loadout_plan   │   ├─ Analyst     (post-round)      │
│   3 retreat & heal / mine         │ ◄────────────── │   └─ Tuner       (post-round)      │
│   4 gravity well (opportunistic)  │                 │                                    │
│   5 engage target (attack/grapple)│  OpenRouter (any model per agent)                     │
│   6 grab pickups                  │  REST: leaderboard / bounties / stats                 │
│   7 hold ground for zone          │   snapshot                                            │
│                                    │ ──────────────► │                                    │
└───────────────────────────────────┘                 └───────────────────────────────────┘
```

**Why this is fast & robust**

- The Engine's per-tick `Controller.decide()` is pure, allocation-light, and runs in well under a
  millisecond. It is the *only* thing in the loop.
- The Brain publishes a compact **Directive** (posture, objective, target, retreat threshold,
  aggression). The Engine reads the latest one each tick — but works perfectly with **no Brain at
  all** (sensible deterministic defaults).
- Every layer degrades gracefully: **no Redis?** run single-process with the in-memory bus. **No
  OpenRouter key?** the bot fights on pure deterministic strategy. **LLM slow/down?** agents time
  out and the last good directive (or the default) stays in force. Agents never throw — a
  failed/timed-out/schema-invalid call just returns `null` and the last-good state stays in force.

### The priority pipeline (`src/engine/controller.ts`)

Every tick runs a fixed chain, first match wins:

1. **Survive zone/hazards** — outside the safe zone or standing on a hazard/burn tile, get to
   safety first (graduated hard/soft zone-edge margin so the bot doesn't ping-pong at the
   boundary). An *imminent* charged/high-charge-bow hit can preempt even this.
2. **Emergency dodge** — just hit, under melee pressure, or about to eat a charged/heavy-charge
   attack; dodge direction is chosen from the threat field, not "away from the nearest enemy."
3. **Retreat & heal / mine** — below a trade-adjusted HP threshold, fall back toward
   heals/safety (firing back at in-range chasers if ranged); may drop a mine behind a pursuing
   chaser on the way out (bearing-checked, capped 3/round).
4. **Gravity well** — opportunistic AoE setup on an enemy cluster (staff/grapple).
5. **Engage target** — pick the best target (see [Targeting](#targeting--trade-math) below),
   run trade math, and either fight (per-weapon attack logic) or disengage to safe ground if the
   trade is bad or a `2+`-enemy endgame crowd demands extra caution.
6. **Grab pickups** — opportunistic detour to nearby loot/heals on the way to/from combat.
7. **Hold ground for zone** *(default)* — capture-pad objective → search last-seen enemies →
   seek a pickup → follow server hints → idle on capture pads → patrol.

### The LLM agents

| Agent | Cadence | Model (default) | Job |
| --- | --- | --- | --- |
| **Loadout** | per connect/round | `anthropic/claude-sonnet-4.6` | Draft weapon + stat spread vs. the meta, round modifier, and **known opponents from past rounds**. |
| **Strategist** | per round | `anthropic/claude-sonnet-4.6` | Set posture, objective, who to hunt/avoid, retreat threshold; aware of bounties and the round modifier. |
| **Tactician** | ~every 2.5 s | `anthropic/claude-haiku-4.5` | Fast mid-fight tweaks: focus the low-HP target, flip to retreat, dial aggression; reads the round modifier too. |
| **Analyst** | post-round | `anthropic/claude-sonnet-4.6` | Watch the tape: distil lessons + opponent profiles into persistent insights. |
| **Tuner** | post-round | `anthropic/claude-sonnet-4.6` | Rewrite the engine's behaviour **policy** live (see below). |
| **Coordinator** | ~every 3 s, squad-wide | `anthropic/claude-sonnet-4.6` | *One* instance for the whole coalition (not per-bot); assigns focus target + roles. Only runs with `BOT_COOP=true` and 2+ bots. |

### Live re-tuning — change behaviour without a restart

The engine's combat constants (dodge eagerness, kite distance, target-scoring weights, pickup
detour, zone margin, mine usage, trade thresholds, gank-anticipation radius, endgame posture,
bounty-target weight, the posture/aggression baseline, and per-weapon tactics like bow-charging /
dagger-flanking / spear-brace / staff gravity-wells) are **not hardcoded** — they live in a
runtime `EnginePolicy` (defaults in `src/types/internal.ts`). The **Tuner** agent rewrites that
policy after each round based on how the fight went; the new policy flows over the bus
(`arena:policy`) and the engine applies it on the **next tick**. Every value is clamped by
`mergePolicy()` (a wild LLM number can nudge but never break the bot), and the policy is mirrored
to Redis KV so learned tuning **survives a restart**. The fast 10 Hz loop stays fully
deterministic; the LLM only owns the knobs.

For controlled experiments you can also pin the policy directly with **`ENGINE_POLICY_OVERRIDES`**
(a JSON object of `EnginePolicy` fields, env-only) — it's merged in on startup ahead of the
Tuner's live patches, which is how we ran the live A/B below without shipping separate builds.
Tag outcome-log rows for comparison with **`POLICY_VARIANT`** (any string).

### Spatial & combat intelligence (deterministic, in-loop)

Drawn from competitive RTS-bot practice, three deterministic systems run inside the tick loop:

- **Threat/influence map** (`threatField.ts`) — a local danger field (enemy weapon coverage + zone +
  hazards) rebuilt each tick. Dodging, kiting and disengaging pick the *lowest-danger tile/gradient*
  instead of naively "stepping away from the nearest enemy" (which is how you dodge one bow into
  another's line and die).
- **Trade evaluator** (`combatMath.ts`) — a cheap "will I win this exchange?" estimate (our DPS-vs-their-HP
  against incoming DPS-vs-our-HP, counting nearby gankers and our defence). Feeds target scoring and a
  **disengage rule**: don't commit to a losing, un-pinned fight — back off to safe ground.
  Includes **gank anticipation**: a third bot that's closing distance (not just adjacent) contributes
  a distance-faded share of its DPS to the trade estimate *before* it's actually in range, so the bot
  sours a 1v1 trade early instead of getting caught by a late arrival.
- **Movement prediction / target leading** — per-enemy velocity is tracked across ticks, so we
  intercept where a target is *heading* and place staff AoE / lead chases ahead of it, not on its
  last tile.

All three expose knobs to the Tuner (`minTradeAdvantage`, `gankRadius`/`gankApproachWeight`,
`leadTicks`, plus the threat field feeding dodge/retreat), so the LLM can dial how cautious vs.
aggressive the bot plays — live.

### Targeting & trade math

`selectTarget` (`src/engine/behaviors/targeting.ts`) scores every visible enemy on low-HP,
matchup rating (`matchups.ts`), distance, exposure/stun/cooldown windows, line-of-sight, threat
aversion, trade advantage, and a **bounty weight**: enemies the arena's bounty board currently
flags are worth an extra score bump (`targetBountyWeight`, id-matched first, name-matched as
fallback) on top of the older blanket bonus for a `hunt_bounty` objective. The Brain's chosen
`primaryTargetId` is honored unless it scores very poorly, and a hysteresis window
(`targetSwitchHysteresis`) stops the bot flip-flopping between two similarly-scored targets.

### Round-history & opponent memory

The Brain persists two things to **disk** (`src/shared/memoryStore.ts`, scoped per bot key,
`BRAIN_MEMORY_DIR`, default `logs/brain/`) in addition to the shorter-lived Redis KV mirror: a
rolling **round history** and a per-opponent **profile registry** (weapon tendencies, ELO,
danger rating, how past fights against them went). These are restored on process start, updated
after every round (persisted *before* the slower post-round Analyst/Tuner calls run, so a crash
mid-analysis doesn't lose the round), and fed back into the Loadout agent's prompt as
`known_opponents` — so a reconnecting bot counter-picks specific rivals it has seen before, not
just the abstract weapon-matchup matrix.

> Models are env-configurable — any current OpenRouter slug works (e.g. bump the planners to
> `anthropic/claude-opus-4.8` for maximum strength, or `anthropic/claude-opus-4.8-fast` for lower latency).

All outputs are **Zod-validated**; stat blocks are normalised to always sum to the 20-point budget,
so the server never rejects a loadout. Any agent may fail — the orchestrator just keeps the last
good directive.

---

## Project layout

```
src/
  config.ts            validated env config + role flags
  main.ts               entrypoint; starts Engine and/or Brain by ROLE
  types/
    protocol.ts          full arena wire protocol (WS + REST)
    internal.ts           Directive / GameSnapshot / LoadoutPlan / EnginePolicy (bus payloads)
  arena/
    rest.ts               REST client (keys, leaderboard, bounties, map, status)
    ws.ts                 resilient WebSocket: frame whitelisting, stall-drop, reconnect + 25 msg/s token bucket
  bus/
    types.ts               Bus interface (publish/subscribe/KV)
    redis.ts                Redis bus (dual connection: pub/sub + KV)
    memory.ts                in-process bus for single-process dev
  engine/
    index.ts               wires socket + world model + controller + bus + outcome/telemetry logging
    gameState.ts             world model rebuilt from each tick (incl. bounty tracking)
    controller.ts             the priority pipeline (the brain stem)
    threatField.ts            per-tile danger/influence map
    combatMath.ts              trade evaluator + gank anticipation
    matchups.ts                weapon-matchup matrix + counter-pick scoring
    pathfinding.ts             capped A* on the grid (local stepping)
    weapons.ts                 weapon profiles + default stat spreads
    loadout.ts                 deterministic fallback loadout chooser
    telemetry.ts                builds the compact snapshot for the Brain
    telemetryLog.ts              optional per-tick JSONL debug log (TELEMETRY_LOG=1)
    outcomeLog.ts                 persistent per-round outcome log (cause of death, variant tag)
    coop.ts                        bot-to-bot coalition (BOT_COOP): non-aggression + focus fire + shared intel
    behaviors/                     survival, emergency dodge, combat, targeting, movement
  brain/
    index.ts                starts the orchestrator
    orchestrator.ts          schedules agents, merges outputs into a Directive, persists memory
    openrouter.ts             OpenRouter chat client (timeout + retry)
    coopCoordinator.ts         squad-wide Coordinator scheduling (BOT_COOP)
    agents/                     base + loadout + strategist + tactician + analyst + tuner + coordinator + schemas
  shared/
    derived.ts  matchups*  geometry.ts  stats.ts  ratelimit.ts  json.ts  logger.ts  proxy.ts  memoryStore.ts
scripts/
  generate-key.ts          `npm run keygen`
  smoke.ts                  offline assertions, `npm run smoke` / `npm test`
  simulate.ts                offline self-play policy sweep, `npm run sim`
  analyze-telemetry.ts        reads TELEMETRY_LOG JSONL for a round
  analyze-outcomes.ts          reads the persistent outcome log for win-rate / loss-cause / A/B analysis
docs/
  arena-spec.md              canonical protocol/mechanics reference
  audit/                       behavior-trace, telemetry, and live win-rate A/B audit passes
```

*(`src/shared/matchups*` above is shorthand — the matchup logic lives at
[`src/engine/matchups.ts`](src/engine/matchups.ts); grouped here for readability.)*

---

## Quick start

### 1. Install & get a key

```bash
npm install
npm run keygen          # prints an api_key — paste it into .env
cp .env.example .env    # set ARENA_API_KEY (and OPENROUTER_API_KEY for the brain)
```

### 2. Run it

**Single process, no Redis, deterministic only** (simplest — just fight):

```bash
# .env: ROLE=all  BUS=memory  (OPENROUTER_API_KEY empty)
npm run dev
```

**Single process with the LLM brain** (set `OPENROUTER_API_KEY` in `.env`):

```bash
# .env: ROLE=all  BUS=memory  OPENROUTER_API_KEY=sk-or-...
npm run dev
```

**Split Engine/Brain over Redis (production topology):**

```bash
# Terminal 0: redis-server   (or use docker compose below)
# .env: BUS=redis  REDIS_URL=redis://127.0.0.1:6379
npm run dev:brain      # ROLE=brain
npm run dev:engine     # ROLE=engine
```

**Docker (Redis + Engine + Brain):**

```bash
docker compose up --build
# deterministic only:
docker compose up --build redis engine
```

**Redis live dashboard (web UI):** the `redis-dashboard` service serves
[RedisInsight](https://redis.io/insight/) on <http://localhost:5540>,
pre-connected to the bus — no setup dialog on first open:

```bash
docker compose up redis redis-dashboard
```

- **Browser** tab → the KV mirror (`bot0:arena:kv:*`): current directive,
  tuning policy, learning insights (entries carry a ~300s TTL, so an idle
  bot's keys expire — that's normal, not a bug).
- **Pub/Sub** tool → subscribe to pattern `*` to stream the live bus traffic
  (snapshots, directives, loadout plans, coalition reports) as it flows
  between Engine and Brain.
- Only meaningful with `BUS=redis` (the compose topology). A `BUS=memory`
  process keeps the bus in-process and Redis stays empty.

### 3. Verify

```bash
npm run smoke        # offline: controller + bus + stats assertions
npm run sim           # offline: self-play policy sweep against scripted opponents
npm run typecheck      # strict tsc, no emit
npm run build            # production bundle via tsup
```

### 4. Analyze past rounds

```bash
npx tsx scripts/analyze-outcomes.ts               # win-rate / loss-cause / per-variant summary
npx tsx scripts/analyze-outcomes.ts --last 20       # just the most recent 20 rounds
npx tsx scripts/analyze-telemetry.ts logs/telemetry/<round-file>.jsonl   # per-tick decision trace
```

---

## Running multiple bots in parallel

Set `ARENA_API_KEYS` to a comma-separated list of keys (one per bot) — the process
launches an independent bot per key, each with its own identity (`BOT_NAME-1`,
`BOT_NAME-2`, …), colour, LLM brain, and an isolated bus scope (`bot0:`, `bot1:`, …)
so their snapshots/directives/policies never collide.

To name each bot individually, set `BOT_NAMES` (and optionally `BOT_COLORS`) —
comma-separated, aligned by position with the keys. Empty slots keep the derived
default, and duplicate names are auto-suffixed so your own bots never shadow each
other:

```bash
ARENA_API_KEYS=key1,key2,key3
BOT_NAMES=Reaper,,Wraith        # bot 2 keeps the default BOT_NAME-2
BOT_COLORS=ff5252,,7c4dff       # bare hex — see the BOT_COLOR note in .env.example
```

> **`.env` gotcha:** dotenv treats an unquoted `#` as a comment, so
> `BOT_COLOR=#00d4ff` in a `.env` file reads back **empty** and the default is
> silently used. Write bare hex (`BOT_COLOR=00d4ff`) or quote the value.

```bash
npm run keygen   # repeat per bot
# .env:  ARENA_API_KEYS=key1,key2,key3
npm run dev
# or Docker (pass the same list to engine + brain):
ARENA_API_KEYS=key1,key2 docker compose up --build
```

`ARENA_API_KEY` (single key) still works and is the default when `ARENA_API_KEYS` is
unset. Each bot runs N× the LLM cost (its own brain), so size your OpenRouter budget
accordingly.

### Coalition play (`BOT_COOP`)

Set `BOT_COOP=true` to make your parallel bots cooperate instead of fighting as
strangers. Coalition comms ride a single **global** bus channel (`arena:coop`),
outside the per-bot scopes, so every one of your bots hears every other. Each bot
broadcasts its position and visible enemies ~2×/sec; from that pooled view the
coalition gains three things:

- **No friendly fire** — allies learn each other's arena `bot_id`s and drop them
  from targeting entirely (they're filtered out of `enemies()`).
- **Focus fire** — when the Brain hasn't pinned a target, every ally converges on
  the lowest-HP enemy *anyone* can see, collapsing opponents faster.
- **Shared intel** — enemy sightings are pooled, so a bot can react to a threat
  a teammate spotted before it enters its own view.

It's purely additive and best-effort: with a single bot it's a no-op, and if a
peer goes silent its stale entries time out (allies after 8s, reported enemies
after 4s) and everyone falls back to fighting solo.

**Coordinator brain (military tactics).** When `BOT_COOP=true` *and* the LLM
brain is enabled *and* 2+ bots are running, ONE additional agent — the
Coordinator — starts alongside the per-bot Strategist/Tactician/Tuner/Loadout
agents. It's squad-wide, not per-bot: it reads the same `arena:coop` pool every
engine already publishes to and, every few seconds (with at least 2 members and
1 tracked enemy reporting), calls basic fireteam tactics over the global
`arena:coop_directive` channel:

- **Concentration of fire** — one shared focus target for the whole squad,
  overriding each bot's own lowest-HP heuristic when it's fresh.
- **Roles** — assigns each ally `hold` (tanky melee anchors the front, less
  eager to retreat), `flank` (mobile weapons exploit an opening, more
  aggressive), or `support` (ranged hangs back, retreats sooner), matched to
  their weapon and applied as adjustments to the engine's retreat/aggression
  knobs.
- **Regroup calls** — flags when the squad is scattered and low HP instead of
  fighting piecemeal.

Falls back to the existing lowest-HP heuristic (no roles) the moment it's
disabled, quiet, or stale — never a hard dependency.

```bash
# .env:  ARENA_API_KEYS=key1,key2,key3   BOT_COOP=true
npm run dev
```

## Configuration

All via env (see `.env.example`). Highlights:

| Var | Default | Notes |
| --- | --- | --- |
| `ROLE` | `all` | `engine` \| `brain` \| `all` |
| `BUS` | `memory` | `redis` for split processes; `memory` requires `ROLE=all` |
| `ARENA_API_KEY` | — | required for the engine; `npm run keygen` |
| `ARENA_API_KEYS` | — | comma-separated keys ⇒ one bot per key, run in parallel |
| `BOT_COOP` | `false` | `true` ⇒ your parallel bots form a coalition (no friendly fire, focus fire, shared intel, squad Coordinator) |
| `OPENROUTER_API_KEY` | — | empty ⇒ pure deterministic bot (no LLM cost) |
| `OPENROUTER_MODEL_*` | claude-sonnet-4.6 / claude-haiku-4.5 | any current OpenRouter model slug (`_STRATEGIST`/`_TACTICIAN`/`_LOADOUT`/`_COORDINATOR`); Analyst and Tuner share the Strategist's model |
| `TACTICIAN_INTERVAL_MS` | `2500` | mid-round re-evaluation cadence (floored at 800 ms) |
| `COOP_COORDINATOR_INTERVAL_MS` | `3000` | squad-wide Coordinator re-evaluation cadence (needs `BOT_COOP=true` + 2+ bots; floored at 1000 ms) |
| `LLM_TIMEOUT_MS` | `8000` | hard cap before falling back to deterministic logic (floored at 1000 ms) |
| `ENGINE_POLICY_OVERRIDES` | — | JSON object of `EnginePolicy` fields, pinned on startup ahead of Tuner patches — for controlled live A/B tests, not in `.env.example` |
| `POLICY_VARIANT` | — | free-text tag written into each outcome-log row, pairs with the override above |
| `OUTCOME_LOG` / `OUTCOME_LOG_DIR` | on / `logs/outcomes` | persistent per-round outcome JSONL (`OUTCOME_LOG=0` disables); powers `analyze-outcomes.ts` |
| `TELEMETRY_LOG` / `TELEMETRY_LOG_DIR` | off / `logs/telemetry` | per-tick decision-trace JSONL (`TELEMETRY_LOG=1` enables); powers `analyze-telemetry.ts` |
| `BRAIN_MEMORY` / `BRAIN_MEMORY_DIR` | on / `logs/brain` | disk persistence of round history + opponent profiles across restarts (`BRAIN_MEMORY=0` disables) |

---

## Performance notes

- **Hot path is allocation-light.** `Controller.decide()` filters the current entity list and runs
  a fixed priority chain — no async, no I/O, no LLM. Snapshots for the Brain are published only
  ~2×/sec, off the critical path.
- **Outbound is rate-limited** with a token bucket (self-capped at 20 msg/s, burst 6) so we never
  trip the 25 msg/s server limit and get kicked. If the socket's own send buffer backs up (a
  stalled pipe), the engine **drops** the queued per-tick action rather than let it burst out
  later — a stale action is worthless once the next tick has already superseded it, and letting a
  backlog flush at once is what trips the server's rate limiter.
- **Pathfinding is bounded.** Local A* is capped at 1500 expansions; for long hauls we defer to the
  server's own `move_to` pathfinder.
- **Redis pub/sub** delivers directives with push latency; a KV mirror lets a restarted Engine or
  Brain pick up current state immediately instead of waiting for the next message.
- **Malformed server frames can't confuse the client.** Only a known whitelist of message `type`s
  is dispatched to internal handlers; anything else (or invalid JSON) is logged and dropped instead
  of tripping reconnect/lifecycle logic.

---

## Measuring what actually wins: the live win-rate audit

Past a certain point, tuning combat behavior by reading code stops being reliable — you have to
measure it in live rounds. `docs/audit/pass3-winrate-phase0-1.md` and
`pass3-winrate-phase2-3.md` document a five-arm live A/B (`ENGINE_POLICY_OVERRIDES` +
`POLICY_VARIANT`, analyzed with `analyze-outcomes.ts`) run against the production arena:

| Arm | Rounds | Wins | Notes |
| --- | --- | --- | --- |
| `baseline` (pre-audit build) | 11 | 2 (18%) | |
| `pass3` (all new knobs on) | 11 | 0 | run during heavy infra/latency noise |
| `control` (all new knobs off) | 11 | 3 (27%) | |
| `pass3b` (all new knobs on, clean run) | 7 | 0 | |
| **`pass3c`** (endgame **off**, gank + shove + bounty **on**) | 11 | **4 (36%)** | best arm |

**Result: zone-endgame posture measured harmful.** Pooled across every arm, endgame-posture-ON
rounds won 0/18 vs. 7/22 for endgame-OFF (Fisher's exact p≈0.01). Telemetry traced it to the
center-hold behavior displacing normal hunting for too much of the round — this arena's rounds
run fast (~60s to a kill is common), so "endgame" positioning covered far more of the round than
it was designed for. **`endgameZoneRadius` now defaults to `0`** (effectively off) in
`DEFAULT_POLICY`; the knob and code path are untouched (still Tuner-adjustable, still
smoke-tested) in case a slower-round meta makes it worth revisiting. Gank anticipation, the
shove-interrupt, and bounty-weighted targeting measured net-positive and stayed on by default.

Re-run or extend this yourself with `ENGINE_POLICY_OVERRIDES`/`POLICY_VARIANT` per run and
`npx tsx scripts/analyze-outcomes.ts` to compare arms.

---

## Troubleshooting

**`websocket error: Unexpected server response: 200` (the bot can't connect).**
This was traced to a **server-side bug in the arena**, not the client or your network. Verified
against the live server (real cert, transparent connection):

| Request | Result |
| --- | --- |
| `/ws/spectator` | `101` ✓ upgrades |
| `/ws/bot` with **no** key | `101` ✓ upgrades |
| `/ws/bot?key=…` (documented query auth) | **`200`** ✗ refuses upgrade |
| `/ws/bot` + `X-Arena-Key` header (documented) | **`200`** ✗ refuses upgrade |
| `/ws/bot` no key → `{"type":"auth","api_key":"…"}` | accepted ✓ |

The documented `?key=` and `X-Arena-Key` auth paths make the server answer the handshake with a plain
`200` instead of `101 Switching Protocols`, so no bot can connect (which is why `bots_online` sits at
`0`). The third documented method — **direct-message authentication** — works: connect with no key,
then send `{"type":"auth","api_key":"…"}` as the first frame.

**The bot uses direct-message auth by default** (`ARENA_WS_AUTH=message`), so it sidesteps the bug. If
the arena fixes the query path you can switch back with `ARENA_WS_AUTH=query`. If you *still* see a
non-`101` on `message` mode, that's a separate WebSocket-blocking proxy (e.g. Zscaler SSL inspection)
— see below.

**Behind a TLS-inspecting proxy (Zscaler).** Such proxies decrypt HTTPS (hence the bundled root CA in
the Docker image) but may not forward WebSocket upgrades. REST/LLM calls still work. Fixes, best first:
1. **Exempt `arena.angel-serv.com` from SSL inspection** (do-not-decrypt / bypass list).
2. **Run the bot off the inspected network** — a cloud VM, or a split-tunnel to the arena.
3. **Point `HTTPS_PROXY` at a proxy that tunnels WebSockets** (HTTP `CONNECT`), with internal hosts
   (e.g. `redis`) in `NO_PROXY`. The bot routes both `ws` and `fetch` through it.

**Docker + corporate root CA.** The `Dockerfile` installs `ZscalerRootCertificate-2048-SHA256.crt`
into the system trust store and sets `NODE_EXTRA_CA_CERTS`, so Node trusts the proxy's intercepted
TLS. If your proxy uses a different root CA, drop its `.crt` in the repo root and update the two
`COPY` lines (or remove them entirely when not behind an inspecting proxy).

**Loadout rejected / never confirmed.** Stats must be integers in `[1,10]` summing to `20`; the bot
normalises this automatically (`src/shared/stats.ts`), so this usually means a stale `ARENA_API_KEY`.

**Kills show no killer name/weapon.** The live server sometimes sends `death` frames with an empty
`killer_name`/`weapon_used`. The engine recovers both from the killer's last-seen entity state
before logging the round outcome — if you still see blanks in `logs/outcomes/`, the killer likely
left visibility range entirely before the kill was confirmed.

## Extending

- **Tune behaviour:** edit `src/engine/behaviors/*` (targeting heuristics, kiting distances, mine
  cadence), `src/engine/combatMath.ts` / `threatField.ts` (trade math, danger scoring), and
  `src/engine/weapons.ts` (per-weapon profiles & default stats). Prefer adjusting
  `DEFAULT_POLICY` in `src/types/internal.ts` (or `ENGINE_POLICY_OVERRIDES` for a quick live
  test) over hardcoding new constants — it keeps the value Tuner-adjustable and A/B-able.
- **Change strategy:** edit the agent prompts/schemas in `src/brain/agents/*`. Add a new agent by
  extending `Agent<TInput, TOutput>` and wiring it into the `Orchestrator`.
- **Swap the bus:** implement the `Bus` interface (`src/bus/types.ts`) for NATS/Kafka/etc.
- **Validate a behavior change before shipping:** `npm run sim` runs the real `Controller` in an
  offline scripted-opponent sweep; `ENGINE_POLICY_OVERRIDES` + `POLICY_VARIANT` +
  `analyze-outcomes.ts` let you A/B it live without a separate build (see
  [Measuring what actually wins](#measuring-what-actually-wins-the-live-win-rate-audit) above).

The bot was written against the live protocol at `arena.angel-serv.com`; if the server changes a
message shape, update `src/types/protocol.ts` first — everything else is typed off it.
