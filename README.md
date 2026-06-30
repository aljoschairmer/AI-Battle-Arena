# AI Battle Arena — Multi-Agent TypeScript Bot

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
| Round length | up to 300 s, with a shrinking safe zone (3 HP/tick outside) |
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
│   1 survive zone/hazards          │                 │   └─ Loadout     (per connect)     │
│   2 emergency dodge               │  loadout_plan   │                                    │
│   3 retreat & heal / mine         │ ◄────────────── │  OpenRouter  (any model per agent) │
│   4 engage target (attack/grapple)│                 │  REST: leaderboard / bounties      │
│   5 grab pickups                  │   snapshot      │                                    │
│   6 hold ground for zone          │ ──────────────► │                                    │
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
  out and the last good directive (or the default) stays in force.

### The three LLM agents

| Agent | Cadence | Model (default) | Job |
| --- | --- | --- | --- |
| **Loadout** | per connect | `anthropic/claude-sonnet-4.6` | Draft weapon + stat spread vs. the meta and round modifier. |
| **Strategist** | per round | `anthropic/claude-sonnet-4.6` | Set posture, objective, who to hunt/avoid, retreat threshold. |
| **Tactician** | ~every 2.5 s | `anthropic/claude-haiku-4.5` | Fast mid-fight tweaks: focus the low-HP target, flip to retreat, dial aggression. |

> Models are env-configurable — any current OpenRouter slug works (e.g. bump the planners to
> `anthropic/claude-opus-4.8` for maximum strength, or `anthropic/claude-opus-4.8-fast` for lower latency).

All outputs are **Zod-validated**; stat blocks are normalised to always sum to the 20-point budget,
so the server never rejects a loadout. Any agent may fail — the orchestrator just keeps the last
good directive. Models are env-configurable (any OpenRouter slug).

---

## Project layout

```
src/
  config.ts            validated env config + role flags
  main.ts              entrypoint; starts Engine and/or Brain by ROLE
  types/
    protocol.ts        full arena wire protocol (WS + REST)
    internal.ts        Directive / GameSnapshot / LoadoutPlan (bus payloads)
  arena/
    rest.ts            REST client (keys, leaderboard, bounties, map, status)
    ws.ts              resilient WebSocket: reconnect + 25 msg/s token bucket
  bus/
    types.ts           Bus interface (publish/subscribe/KV)
    redis.ts           Redis bus (dual connection: pub/sub + KV)
    memory.ts          in-process bus for single-process dev
  engine/
    index.ts           wires socket + world model + controller + bus
    gameState.ts       world model rebuilt from each tick
    controller.ts      the priority pipeline (the brain stem)
    pathfinding.ts     capped A* on the grid (local stepping)
    weapons.ts         weapon profiles + default stat spreads
    loadout.ts         deterministic fallback loadout chooser
    telemetry.ts       builds the compact snapshot for the Brain
    behaviors/         survival, targeting, combat, movement
  brain/
    index.ts           starts the orchestrator
    orchestrator.ts    schedules agents, merges outputs into a Directive
    openrouter.ts      OpenRouter chat client (timeout + retry)
    agents/            base + loadout + strategist + tactician + schemas
  shared/
    geometry.ts  stats.ts  ratelimit.ts  json.ts  logger.ts
scripts/
  generate-key.ts      `npm run keygen`
  smoke.ts             offline assertions, `npm run smoke`
```

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

### 3. Verify

```bash
npm run smoke        # offline: controller + bus + stats assertions
npm run typecheck    # strict tsc, no emit
npm run build        # production bundle via tsup
```

---

## Configuration

All via env (see `.env.example`). Highlights:

| Var | Default | Notes |
| --- | --- | --- |
| `ROLE` | `all` | `engine` \| `brain` \| `all` |
| `BUS` | `memory` | `redis` for split processes; `memory` requires `ROLE=all` |
| `ARENA_API_KEY` | — | required for the engine; `npm run keygen` |
| `OPENROUTER_API_KEY` | — | empty ⇒ pure deterministic bot (no LLM cost) |
| `OPENROUTER_MODEL_*` | claude-sonnet-4.6 / claude-haiku-4.5 | any current OpenRouter model slug |
| `TACTICIAN_INTERVAL_MS` | `2500` | mid-round re-evaluation cadence |
| `LLM_TIMEOUT_MS` | `8000` | hard cap before falling back to deterministic logic |

---

## Performance notes

- **Hot path is allocation-light.** `Controller.decide()` filters the current entity list and runs
  a fixed priority chain — no async, no I/O, no LLM. Snapshots for the Brain are published only
  ~2×/sec, off the critical path.
- **Outbound is rate-limited** with a token bucket (self-capped at 20 msg/s, burst 6) so we never
  trip the 25 msg/s server limit and get kicked.
- **Pathfinding is bounded.** Local A* is capped at 1500 expansions; for long hauls we defer to the
  server's own `move_to` pathfinder.
- **Redis pub/sub** delivers directives with push latency; a KV mirror lets a restarted Engine or
  Brain pick up current state immediately instead of waiting for the next message.

---

## Troubleshooting

**`websocket error: Unexpected server response: 200` and constant reconnects.**
The arena bot endpoint is a real WebSocket (`wss://…/ws/bot?key=…`) — verified: with a valid key the
origin returns the `Upgrade: websocket` handshake. If you see `200` instead of `101`, you're behind a
proxy that **MITMs HTTPS but doesn't tunnel WebSocket upgrades** (some corporate egress proxies and
sandboxed CI environments do this). The bot is proxy-aware via `HTTPS_PROXY`/`NO_PROXY` (it wires the
proxy into both `ws` and `fetch`), but a proxy that refuses WS upgrades simply cannot carry the
connection. Fixes: run the bot on a network path with direct egress to `arena.angel-serv.com:443`, or
use a proxy that supports HTTP `CONNECT` WebSocket tunneling. REST features (leaderboard, bounties,
key generation) work through ordinary proxies regardless.

**Loadout rejected / never confirmed.** Stats must be integers in `[1,10]` summing to `20`; the bot
normalises this automatically (`src/shared/stats.ts`), so this usually means a stale `ARENA_API_KEY`.

## Extending

- **Tune behaviour:** edit `src/engine/behaviors/*` (targeting heuristics, kiting distances, mine
  cadence) and `src/engine/weapons.ts` (per-weapon profiles & default stats).
- **Change strategy:** edit the agent prompts/schemas in `src/brain/agents/*`. Add a new agent by
  extending `Agent<TInput, TOutput>` and wiring it into the `Orchestrator`.
- **Swap the bus:** implement the `Bus` interface (`src/bus/types.ts`) for NATS/Kafka/etc.

The bot was written against the live protocol at `arena.angel-serv.com`; if the server changes a
message shape, update `src/types/protocol.ts` first — everything else is typed off it.
