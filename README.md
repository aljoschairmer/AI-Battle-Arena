<div align="center">

# ⚔️ AI Battle Arena Bot

**A real-time combat bot with a split brain: deterministic 10 Hz engine, LLM strategy layer.**

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](tsconfig.json)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522-339933?logo=node.js&logoColor=white)](package.json)
[![CI](https://github.com/aljoschairmer/AI-Battle-Arena/actions/workflows/ci.yml/badge.svg)](.github/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-vitest%20%2B%20smoke-brightgreen)](test/)
[![Built by AI](https://img.shields.io/badge/built%20by-AI%20agents%2C%20100%25-blueviolet)](#-disclaimer)
[![Arena](https://img.shields.io/badge/plays%20on-arena.angel--serv.com-orange)](https://arena.angel-serv.com/)

[Quick start](#-quick-start) ·
[Architecture](#-architecture) ·
[Fleet & coalition](#-fleet--coalition) ·
[Observability](#-observability) ·
[Configuration](#-configuration) ·
[Results](#-measured-results)

</div>

---

> ## ⚠️ Disclaimer
> This project was **built and programmed entirely by AI agents** (Claude Code) —
> architecture, engine, brain, tests, audits, and even this disclaimer. Not a single
> line was written by hand. Which makes it, officially, **the worst code I have ever
> coded** — I didn't code any of it. Read, run, and judge accordingly.

---

## 💡 The core idea

[AI Battle Arena](https://arena.angel-serv.com/) ticks at **10 Hz** — you get 100 ms to answer
every frame. An LLM can't do that, so LLMs must **never sit in the control loop**:

- A **deterministic Engine** fights every tick in well under a millisecond — targeting, trade
  math, threat fields, pathfinding, dodges.
- A **multi-agent LLM Brain** (via [OpenRouter](https://openrouter.ai), any model per agent)
  sets *strategy* asynchronously: what to draft, whom to hunt, when to be brave.
- A **message bus** (Redis or in-process) is the seam between them, so model latency can never
  stall combat.

Every layer degrades gracefully. No Redis? Single process. No LLM key? Pure deterministic bot.
Model slow or down? The last good directive stays in force. LLM agents fail soft into
deterministic fallbacks; a truly unexpected process error (uncaught exception / unhandled
rejection) shuts down cleanly and lets the container supervisor restart a known-good process
instead of fighting on in an undefined state.

## ✨ Features

- 🎯 **Priority-cascade controller** — 9 rungs from *survive the zone* down to *patrol*, first
  match wins, pure and allocation-light ([`controller.ts`](src/engine/controller.ts))
- 🗺️ **Threat/influence map** — per-tile danger from weapon coverage, zone, hazards, mines;
  dodging and kiting descend the danger gradient instead of "step away from nearest enemy"
- 🧭 **Threat-weighted A\*** — retreats plan a route to safety around wall corners and range
  rings instead of greedy single steps ([`pathfinding.ts`](src/engine/pathfinding.ts))
- ⚖️ **Trade evaluator with gank anticipation** — "will I win this exchange?" including
  closing third parties *before* they're in range ([`combatMath.ts`](src/engine/combatMath.ts))
- 👁️ **Fog-of-war bypass** — the arena's public spectator feed is folded into the engine:
  enemy mines become hazards, confirmed out-of-fog hunters sour the trade early, and the live
  aggro graph powers third-party sniping ([`spectator.ts`](src/arena/spectator.ts))
- 🎛️ **Live-tunable policy** — ~50 behaviour knobs in a runtime `EnginePolicy`; an LLM Tuner
  rewrites them between rounds, every value clamped so a wild number can never brick the bot
- 🤝 **Coalition fleets** — parallel bots share intel, focus fire, avoid friendly fire through
  ten dedicated guard mechanisms… and **turn on each other when only the fleet is left standing**
- 📜 **Evidence-based drafting** — fleet-wide weapon win rates on disk override both the LLM
  *and* the deterministic fallback when they try to draft a proven loser
- 🧠 **Cross-round memory** — opponent profiles, round history and learned insights persist to
  disk and survive restarts
- 🕵️ **Passive scout** (`ROLE=scout` / `docker compose up scout`) — watches the public spectator
  feed 24/7 (no key, no LLM cost) and learns every arena bot's playstyle from rounds we never
  played: win rates, K/D, aggression, preferred range, dodge/mine habits — fed into the Brain's
  drafting and strategy prompts so the fleet counter-picks opponents **before first contact**
- 📊 **Measured, not vibed** — persistent outcome log, per-tick telemetry, offline self-play
  sim, and a built-in A/B mechanism (`ENGINE_POLICY_OVERRIDES` + `POLICY_VARIANT`)

## 🚀 Quick start

```bash
npm install
npm run keygen          # prints an api_key — paste it into .env
cp .env.example .env    # set ARENA_API_KEY (+ OPENROUTER_API_KEY for the brain)
npm run dev             # single process, in-memory bus — it fights
```

That's genuinely all. Variants:

```bash
# Deterministic only (no LLM cost): leave OPENROUTER_API_KEY empty
npm run dev

# Production topology — Engine and Brain as separate processes over Redis:
npm run dev:brain & npm run dev:engine     # .env: BUS=redis

# Docker (Redis + Engine + Brain):
docker compose up --build

# Verify a change before shipping:
npm test             # vitest unit suite (pathfinding, combat math, controller, config)
npm run smoke        # 310+ offline integration assertions across engine + brain + bus
npm run sim          # self-play policy sweep vs scripted opponents
npm run typecheck    # strict tsc
```

## 🏗 Architecture

```
                        ┌────────────────────── bus (Redis / in-memory) ─────────────────────┐
                        │        pub/sub channels          +        KV "last value" mirror   │
                        └────────▲──────────────▲──────────────────────┬─────────────────────┘
        snapshot (2/s) ──────────┘              │                      │
        loadout_request ────────────────────────┘                      │ directive / policy / plan
                                                                       ▼
┌────────────────────────────────────┐                ┌────────────────────────────────────┐
│               ENGINE               │                │                BRAIN               │
│    deterministic · 10 Hz · <1 ms   │                │       LLM agents · async · slow    │
│                                    │                │                                    │
│  WS ◄──► arena     spectator feed  │                │  Orchestrator                      │
│  GameState ── world model          │                │   ├─ Loadout     (per connect)     │
│  ThreatField ── danger map         │                │   ├─ Strategist  (per round)       │
│  Controller ── priority cascade:   │                │   ├─ Tactician   (every ~2.5 s)    │
│   1 survive zone/hazards           │                │   ├─ Analyst     (post-round)      │
│   2 emergency dodge                │                │   ├─ Tuner       (post-round)      │
│   3 retreat & heal / mine          │                │   └─ Coordinator (squad-wide)      │
│   4 gravity well                   │                │                                    │
│   5 engage target / disengage      │                │  OpenRouter · REST (leaderboard,   │
│   6 grab pickups                   │                │  bounties, stats) · disk memory    │
│   7 hold ground / patrol           │                │                                    │
└────────────────────────────────────┘                └────────────────────────────────────┘
```

<details>
<summary><b>The arena in one table</b></summary>

| Property | Value |
| --- | --- |
| Arena | 100×100 tile grid, fog of war (7-tile radius) |
| Tick rate | **10 Hz** — one action per tick |
| Rounds | shrinking safe zone (3 HP/tick outside), sudden death, modifiers |
| Weapons | sword, bow, daggers, shield, spear, staff, grapple |
| Loadout | 1 weapon + 20 stat points across hp/speed/attack/defense (1–10 each) |
| Universal kit | 2 grapple charges + 3 mines + shove per round |
| Scoring | ELO, kills/deaths, streaks, bounties |

Full protocol + mechanics reference: [`docs/arena-spec.md`](docs/arena-spec.md). The derived-stat
formulas (reverse-engineered from the site's simulator and verified to the digit) live in
[`src/shared/derived.ts`](src/shared/derived.ts) — the takeaway: defense is the weakest stat per
point, so default builds split the budget between HP and attack over a per-weapon mobility floor
([`optimizeBuild`](src/shared/derived.ts)).

</details>

<details>
<summary><b>The six LLM agents</b></summary>

| Agent | Cadence | Job |
| --- | --- | --- |
| **Loadout** | per connect | Draft weapon + stats vs. meta, round modifier, lobby scouting and known opponents. Overridden deterministically when it drafts against the fleet's own win-rate evidence. |
| **Strategist** | per round | Posture, objective, hunt/avoid lists, retreat threshold — with fog-free global intel in its prompt. |
| **Tactician** | ~2.5 s | Fast mid-fight adjustments: focus the finishable target, flip to retreat before a gank lands. |
| **Analyst** | post-round | Distils lessons + opponent profiles into persistent insights. |
| **Tuner** | post-round | Rewrites the engine's `EnginePolicy` knobs live — clamped, versioned, mirrored to KV. |
| **Coordinator** | ~3 s, squad-wide | ONE instance for the whole coalition: focus fire, hold/flank/support roles, regroup calls. |

Models are env-configurable per agent (`OPENROUTER_MODEL_*`) — any OpenRouter slug works, from
free tiers to `anthropic/claude-opus-4.8`. All outputs are Zod-validated; failed/slow calls fall
back to the last good state.

</details>

<details>
<summary><b>Deterministic combat intelligence</b></summary>

- **Targeting** ([`targeting.ts`](src/engine/behaviors/targeting.ts)) scores every visible enemy:
  low HP, weapon matchup, distance, exposure/stun windows, LOS, threat aversion, trade advantage,
  bounty carrier bonus, third-party distraction (from the live aggro graph), with hysteresis so
  the bot doesn't flip-flop between similar targets.
- **Trade math** ([`combatMath.ts`](src/engine/combatMath.ts)) compares time-to-kill both ways,
  counts in-range attackers, *approaching* gankers (distance-faded), and spectator-confirmed
  hunters still outside the fog. Feeds both target scoring and the disengage rule.
- **Threat field** ([`threatField.ts`](src/engine/threatField.ts)) — weapon coverage (incl. the
  12-tile grapple yank band), zone, hazards, dormant pulse zones, ally repulsion, mines from all
  three intel channels (own, coalition-broadcast, spectator).
- **Movement** — velocity-tracked target leading, flanking for backstabs, kite-and-fire while
  retreating, grapple zone-escape, capture-pad play, bounty-beacon hunting.

</details>

## 🤝 Fleet & coalition

Run several bots from one process — `ARENA_API_KEYS=key1,key2,key3` gives each key its own
identity, brain and isolated bus scope. With `BOT_COOP=true` they form a coalition:

- **No friendly fire** — allies are filtered from targeting; ten dedicated guard mechanisms
  (cleave arcs, fire lanes, AoE placement, grapple pulls, mine broadcasting + rerouting, pack
  spacing, server-autopilot downgrades) were added one by one until live teammate kills hit zero.
- **Focus fire & shared intel** — pooled sightings, lowest-HP convergence, Coordinator roles.
- **Draft diversity** — slot archetypes (free / ranged / frontline) plus fleet-wide weapon
  evidence: a weapon under 10% win rate over 10+ rounds is banned from the draft, proven winners
  get promoted — enforced deterministically even when the LLM (or its fallback) disagrees.
- ⚔️ **Last fleet standing** — when the spectator feed confirms every living bot is ours, the
  truce ends automatically: exactly one bot can win a round, so the fleet fights it out instead
  of idling until the zone decides. Enemy respawn or feed loss restores the peace.

```bash
# .env: ARENA_API_KEYS=key1,key2,key3  BOT_NAMES=Reaper,HexMind,Ghost  BOT_COOP=true
npm run dev
```

## 📊 Observability

| Tool | What you get |
| --- | --- |
| `logs/outcomes/outcomes.jsonl` | every round: win/loss, weapon, kills, cause of death, policy version, variant tag |
| `npx tsx scripts/analyze-outcomes.ts` | win rate, loss causes, per-weapon and per-variant (A/B) breakdowns |
| `TELEMETRY_LOG=1` + `analyze-telemetry.ts` | per-tick decision traces: which priority rung claimed each tick and why |
| `docker compose up redis redis-dashboard` | **live web dashboard** — [Redis Commander](https://github.com/joeferner/redis-commander) on <http://localhost:5540>, pre-connected (multi-arch: amd64/arm64/armv7); key tree = current directives/policies/insights (KV mirror). Live pub/sub traffic: `docker compose exec redis redis-cli psubscribe '*'` |
| `docker compose up -d redis-dashboard-tunnel` | public quick-tunnel URL for the dashboard (`docker compose logs redis-dashboard-tunnel \| grep trycloudflare`) — unauthenticated, share with care |
| `npm run knowledge:dump` / [`data/knowledge/`](data/knowledge/) | **repo-persisted learning**: learned policies + insights (Redis KV) and brain memory (rounds, opponent profiles) snapshot into the repo — written automatically on every graceful shutdown, replayed automatically on start (missing-only, live state always wins; `KNOWLEDGE_RESTORE=0` disables). With a repo-scoped `GITHUB_TOKEN` a background job commits+pushes the dump on a schedule (`KNOWLEDGE_PUSH_INTERVAL_MS`; the shutdown path never runs git). Commit the folder and a fresh clone starts with everything the fleet ever learned. |

## ⚙️ Configuration

Everything is env-driven (see [`.env.example`](.env.example)). The essentials:

| Var | Default | Notes |
| --- | --- | --- |
| `ROLE` | `all` | `engine` \| `brain` \| `all` |
| `BUS` | `memory` | `redis` for split processes (`memory` requires `ROLE=all`) |
| `ARENA_API_KEY` / `ARENA_API_KEYS` | — | one key = one bot; comma-separated list = parallel fleet |
| `BOT_NAMES` / `BOT_COLORS` | derived | per-bot identity, position-aligned with the key list |
| `BOT_COOP` | `false` | coalition mode for parallel bots |
| `OPENROUTER_API_KEY` | — | empty ⇒ pure deterministic bot, zero LLM cost |
| `OPENROUTER_MODEL_*` | Claude Sonnet/Haiku | per-agent model slugs (`_STRATEGIST` `_LOADOUT` `_TACTICIAN` `_COORDINATOR`) |
| `LLM_TIMEOUT_MS` | `8000` | hard cap before deterministic fallback |
| `ARENA_SPECTATOR` | on | `false` disables the fog-free feed (engine + brain fall back to fog-only) |
| `ENGINE_POLICY_OVERRIDES` | — | JSON of `EnginePolicy` fields pinned at startup — the A/B mechanism |
| `POLICY_VARIANT` | — | free-text tag written into every outcome row |
| `OUTCOME_LOG` / `TELEMETRY_LOG` / `BRAIN_MEMORY` | on / off / on | the three persistence layers (`logs/…`) |

> **`.env` gotcha:** dotenv treats an unquoted `#` as a comment start — write colours as bare hex
> (`BOT_COLOR=00d4ff`).

## 🗂 Project structure

```
src/
├── main.ts / config.ts        entrypoint + validated env config
├── types/                     arena wire protocol · bus payloads (Directive, EnginePolicy, …)
├── arena/                     REST client · resilient WS (rate-limited, stall-dropping) · spectator feed
├── bus/                       Bus interface · Redis impl · in-memory impl · per-bot scoping
├── engine/                    GameState · Controller · ThreatField · combat math · matchups ·
│   ├── behaviors/             A* · weapons · loadout fallback · coalition · outcome/telemetry logs
├── brain/                     Orchestrator · OpenRouter client · draft evidence
│   └── agents/                loadout · strategist · tactician · analyst · tuner · coordinator
└── shared/                    derived stats · geometry · memory stores · logger · proxy
test/                          vitest unit suite (pathfinding · combat math · controller · config)
scripts/                       keygen · smoke (integration, 310+ asserts) · simulate · analyze-{outcomes,telemetry}
docs/                          arena-spec.md · fight-summary.md · audit-history.md (condensed passes)
```

## 📈 Measured results

Tuning combat behaviour by reading code stops working fast — this repo measures instead
(full history: [`docs/fight-summary.md`](docs/fight-summary.md), method:
[`docs/audit-history.md`](docs/audit-history.md) — the full pass-by-pass
documents live in git history):

- **629 logged rounds** against the production arena's house bots (some with 39,000+ rounds of
  play): fleet win rate grew from ~6% to **20% over the latest window** (15-bot FFA ⇒ uniform
  chance is ~7%); ELO 119 → 250+.
- **Weapon evidence beats tier lists:** bow won 23% where daggers won 3% — which is why draft
  evidence enforcement exists at both the LLM and fallback layer.
- **A live A/B killed a feature:** the zone-endgame posture *measured* harmful (0/18 vs 7/22
  wins, Fisher p≈0.01) and now defaults off — the knob survives for the Tuner to revisit.
- **Friendly fire → 0:** ten distinct kill channels found and closed across one night of fleet
  play (51 teammate kills investigated, documented in the audit).

## 🔧 Troubleshooting

<details>
<summary><b>WebSocket won't connect (<code>Unexpected server response: 200</code>)</b></summary>

The arena's documented `?key=` and `X-Arena-Key` auth paths refuse the upgrade server-side. The
bot defaults to the third documented method — direct-message auth (connect bare, send
`{"type":"auth","api_key":"…"}`) — which works (`ARENA_WS_AUTH=message`). If message mode also
fails you're behind a WebSocket-blocking proxy: exempt `arena.angel-serv.com` from SSL
inspection, run off the inspected network, or point `HTTPS_PROXY` at a CONNECT-tunneling proxy.
If your proxy TLS-inspects, point `NODE_EXTRA_CA_CERTS` at your CA file at runtime — corporate
certificates are deliberately not part of this repo or its Docker image.

</details>

<details>
<summary><b>Loadout rejected / blank killer names / empty dashboard</b></summary>

- **Loadout rejected:** stats must be integers 1–10 summing to 20 — the bot normalises this
  automatically, so a rejection usually means a stale `ARENA_API_KEY`.
- **Blank killer name/weapon in outcomes:** the server sometimes sends empty `death` fields; the
  engine recovers them from last-seen entities, but a killer that never entered fog stays `""`
  (an honest unknown, not a bug).
- **Redis dashboard shows nothing:** the dashboard only sees `BUS=redis` traffic; a `BUS=memory`
  process keeps the bus in-process. KV entries carry a ~300 s TTL — an idle bot's keys expiring
  is normal.

</details>

## 🧩 Extending

- **Behaviour:** prefer adding an `EnginePolicy` knob (`src/types/internal.ts` + the clamp table
  + `PolicyPatchSchema`) over a hardcoded constant — it stays Tuner-adjustable and A/B-able.
- **Strategy:** edit the prompts/schemas in `src/brain/agents/`; add an agent by extending
  `Agent<TInput, TOutput>` and wiring it into the `Orchestrator`.
- **Bus:** implement the `Bus` interface (`src/bus/types.ts`) for NATS/Kafka/whatever.
- **Validate first:** `npm run smoke` + `npm run sim` offline, then
  `ENGINE_POLICY_OVERRIDES`/`POLICY_VARIANT` + `analyze-outcomes.ts` live.

The bot is written against the live protocol at `arena.angel-serv.com`; if the server changes a
message shape, update [`src/types/protocol.ts`](src/types/protocol.ts) first — everything else is
typed off it.

---

<div align="center">

**Built entirely by AI agents.** Every bug is a hallucination, every win is emergent behaviour.

</div>
