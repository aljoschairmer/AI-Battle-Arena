# Win-rate pass (pass 3) — Phase 0 baseline + Phase 1 ranked candidates

## Phase 0 — what outcome data existed, what was missing, what was built

### Already available (verified in code)

| Source | What it answers | Limits |
|---|---|---|
| `RoundOutcome` (engine → brain bus msg, `shared/memory.ts`) | per-round kills/deaths, **who killed us + weapon**, who we killed, enemy weapons seen, won, ticks survived, modifier | **in-memory only** — `RoundHistory(30)` in the orchestrator, lost on restart, never written to disk |
| `telemetryLog` JSONL (`TELEMETRY_LOG=1`) | per-tick priority claims, target switches, trade evals, dodge accuracy; `round_end` has win/loss | no cause-of-death, no policy version → can't build a loss-cause distribution from disk |
| REST `/bot/stats`, `/leaderboard` | lifetime ELO, K/D, round_wins/rounds_played | aggregate only, no per-round attribution |
| `scripts/simulate.ts` | offline deterministic 1v5 self-play driving the real Controller; policy sweep | sim opponents are scripted chargers, not the live meta |

**Verdict:** "win rate over the last N rounds" was answerable only while a single
brain process stayed alive; "why did we lose the losses" was answerable never
(not persisted anywhere).

### Built in this phase (before any behavior change)

- `src/engine/outcomeLog.ts` — one JSONL line per round appended to
  `logs/outcomes/outcomes.jsonl` across sessions: full `RoundOutcome` +
  derived `causeOfDeath` (`bot_kill` / `environment` / `no_death_recorded` /
  `won`) + active `policyVersion`/`policySource` + operator `POLICY_VARIANT`
  tag + post-round ELO (best-effort). On by default (`OUTCOME_LOG=0` disables).
- `scripts/analyze-outcomes.ts` — win rate over last N, loss-cause
  distribution, final-killer weapon histogram, multi-attacker (gank-proxy)
  share, weapon/modifier splits, **per-variant comparison** (the A/B mechanism).
- Smoke: 9 new assertions (classification table + JSONL write-path roundtrip
  with variant/policy tagging).

### Baseline batch

Live rounds ARE practical from this environment (arena reachable, key
generated via the public keygen endpoint). Baseline run started before any
behavior change: `POLICY_VARIANT=baseline`, `TELEMETRY_LOG=1`, single bot.
**No OpenRouter key exists in this environment**, so the baseline (and all
live measurement in this pass) exercises the deterministic engine only —
brain-side changes are validated by smoke assertions, not live deltas. Target
N ≈ 12–20 rounds (~5 min/round).

## Phase 1 — ranked candidates (every verdict verified against code)

Already applied by prior passes (re-checked, no action): trade-aware
engage/disengage (`controller.ts:213-218`), target-switch hysteresis
(`targeting.ts:62-69`), threat-field dodge/retreat (`survival.ts:218-229,344`),
weapon tactics for daggers/bow/spear/staff/shield (sword intentionally
generic), opponent profiles → **Strategist** (orchestrator.ts:227), modifier →
Strategist+Loadout prompts, ranged fire-while-kiting, shove cooldown, flank
defer bound.

Ranked list (implementation order = cheapest/highest-confidence first within
impact tiers):

| # | Tag | Item | Verified gap | Justification |
|---|---|---|---|---|
| 1 | new | **Round-outcome log + A/B variant tagging** (done above) | `RoundOutcome` had no disk sink, no policy/variant join (verified absent) | Everything else on this list is judged with it |
| 2 | new | **Opponent profiles → Loadout agent** | orchestrator passes `insights` but NOT `opponentProfiles` to loadout (`orchestrator.ts:256-264`); loadout prompt has no per-opponent counter-pick input | Counter-picking a known opponent's primary weapon is the cheapest real edge; matchup matrix already exists (`matchups.ts`) |
| 3 | new | **Brain memory persistence (disk)** | `RoundHistory`/`OpponentRegistry` are plain in-process objects; KV mirror expires in 300s — a restarted brain forgets every opponent | #2 is near-useless across sessions without it; bounded JSON file, brain-side only |
| 4 | new | **Bounty target wiring (id-true)** | `orchestrator.ts:450-452` drops `bot_id` from bounty entries; Tactician gets no bounties; engine `hunt_bounty` objective gives +15 to ANY enemy (`targeting.ts:135`) — the bot literally cannot tell who has the bounty | Bounty kills are direct score; `double_bounty` modifier doubles the payoff |
| 5 | new | **Gank anticipation in trade math** | `combatMath.ts:29-39` counts a third bot only when already `can_attack` AND ≤5 tiles — an approaching ganker moves the number 0 until it's on top of us | Classic FFA death pattern; gank-proxy share in the outcome log measures it directly |
| 6 | new | **Zone-endgame posture** | No behavior keys off zone radius/round time for posture (verified: `round` consumed only by telemetry; zone logic is stay-inside/edge-margins only) | Late-round small-zone play rewards center control + tighter engage gating; currently 280s plays identical to 20s |
| 7 | new | **Charged-attack punish (shove interrupt)** | Preemptive dodge vs `charged_shot_ready` exists (`survival.ts:127-137`); NO offensive reaction — no shove-interrupt, no close-to-deny (verified absent) | Shove already has 4 wired triggers; a 5th on enemy windup is a small extension with a clean trigger condition |
| 8 | new | **Tactician gets round modifier + bounty context** | Tactician input is `{snapshot, current}` only (verified) | Cheap prompt fix; hazard_storm/fast_zone change mid-round tactics |

Considered and NOT included: proactive mine zoning (carried twice by prior
passes as evidence-unjustified; reactive chase-mine exists), sword-specific
branch (no loss evidence attributable to sword; generic melee path is
reasonable), dodge-candidate widening (prior passes measured 0
hit-despite-lowest-danger).

Measurement plan: engine-side items (5,6,7) get sim sweeps + live A/B via
`POLICY_VARIANT`; brain-side items (2,3,4,8) get smoke assertions (no LLM key
in this environment to measure live).
