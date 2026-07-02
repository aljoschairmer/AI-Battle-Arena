# Win-rate pass (pass 3) — Phase 2 implementation + Phase 3 measurement

Each item validated with `npm run typecheck` + `npm run smoke` (34 new
assertions this pass, suite fully green) before moving to the next.

## Implemented, in order

| # | Tag | Item | Hypothesis | Files | Validation |
|---|---|---|---|---|---|
| 1 | new | Round-outcome log + A/B variant tag | can't improve what isn't measured; turns "lost" into a cause distribution | `engine/outcomeLog.ts`, `engine/index.ts`, `scripts/analyze-outcomes.ts` | 10 smoke asserts; captured the live baseline first try |
| 2 | new | Opponent profiles → Loadout agent | counter-picking known repeat killers' primary weapon beats drafting blind | `brain/agents/loadout.ts`, `brain/orchestrator.ts` | smoke: prompt contains matched profile / null when none / rule present |
| 3 | new | Brain memory persistence (disk) | profiles must survive restarts + the 300s KV expiry for #2 to matter across sessions | `shared/memoryStore.ts`, `shared/memory.ts`, `brain/orchestrator.ts`, `brain/index.ts`, `main.ts` | smoke: save→restart→restore roundtrip, per-scope files |
| 4 | new | Bounty targeting (id-true, engine + brain) | knowing WHO carries the bounty converts bounty rounds into targeted score | `engine/gameState.ts`, `behaviors/targeting.ts`, `engine/index.ts`, `types/internal.ts`, `brain/orchestrator.ts`, `agents/strategist.ts` | smoke: carrier outranks identical non-carrier, name fallback, board replace, clamp. New knob `targetBountyWeight` (25, [0,100]) |
| 5 | new | Gank anticipation in tradeAdvantage | a 1v1-about-to-be-2v1 must read unfavorable BEFORE the third bot is in range | `engine/combatMath.ts`, `types/internal.ts` | smoke: closing-at-8-tiles sours trade, stationary doesn't, weight-0 bit-identical to old math. Knobs `gankRadius` (9, [5,16]) / `gankApproachWeight` (0.5, [0,1]) |
| 6 | new | Zone-endgame posture | tiny zone + 2+ enemies ⇒ demand an even trade + hold center; a lost fight there is terminal | `behaviors/context.ts` (isEndgame), `controller.ts`, `behaviors/movement.ts` | smoke: full-HP disengage in endgame crowd, 1v1 still fights, radius-0 restores old behavior, idle center-hold. Knobs `endgameZoneRadius` (12), `endgameTradeCaution` (0.3), `endgameCenterHoldFraction` (0.4) |
| 7 | new | Charged-attack punish (shove interrupt) | a telegraphed charged shot adjacent to us should be denied by shove's 2-tick stun, not just dodged | `behaviors/combat.ts` | smoke: shove on charged_shot_ready / bow_charge≥2, kill-beats-interrupt, cooldown respected, toggle off. Knob `shoveInterruptCharged` (true) |
| 8 | new | Tactician sees the round modifier | hazard_storm/double_bounty should change mid-round tactics, not just the draft | `brain/agents/tactician.ts` | smoke: prompt carries modifier + rules |
| 9 | fix | Killer name/weapon recovery | live server sends killed_by id but EMPTY killer_name/weapon_used (baseline observation) — attribution was blank | `engine/index.ts`, `engine/outcomeLog.ts` | smoke: bot-less death frame → environment |

All new constants are `EnginePolicy` fields with `mergePolicy` clamps AND
`PolicyPatchSchema` entries (Tuner-patchable). Engine hot path gained no
I/O/async (bounty fetch rides the existing round-boundary REST batch; memory
persistence is brain-side debounced). Degradation preserved: no Redis / no
OpenRouter / no disk all fall back to prior behavior (smoke-asserted where
observable).

## Sim measurements (offline, same-seed A/B, 24 matches × 6 configs × 3 weapons)

- **Gank anticipation** (`SIM_GANK_WEIGHT=0` vs `0.5`): mildly positive to
  neutral. bow `current` 46%→50%, sword `defensive` 42%→46%, daggers kills
  0.54→0.63 at equal win rate; 1 of 18 cells worse (sword `aggressive`
  33%→29%). Kept: direction consistent, magnitude within sim noise.
- **Endgame posture** (`SIM_ENDGAME_RADIUS=0` vs `12`): **neutral** — the sim
  is 1v5 vs scripted chargers and cannot express FFA endgame dynamics
  (placement, third-party opportunism, timeout survival). Not claiming a sim
  win here; live A/B via `POLICY_VARIANT` is the test.
- **Shove interrupt**: no sim delta by construction (sim enemies never charge).

## Live A/B (arena.angel-serv.com, deterministic engine, no LLM key in this env)

Baseline (`variant=baseline`, pre-change code): **11 rounds, 1 win (9%)**,
10 kills / 9 deaths, ELO 969→939 across the batch. Loss causes: 8 bot_kill,
1 no_death_recorded (killer attribution blank server-side → fix #9).

### Final A/B(/C/D) results

Five live arms, one bot, same arena evening (~60s rounds, 15-16 bots, fast
shrink). "Infra storms" = bursts of `WS_RATE_LIMITED` caused by the sandbox
egress proxy batching our evenly-spaced 10/s frames into window-blowing
clumps (verified: telemetry shows exact 100ms action spacing; rejections
arrived 40-in-35ms; our ws bufferedAmount stayed empty, so the clumping is
downstream and unfixable client-side — a bufferedAmount stall guard was added
anyway for process-side stalls, plus ENGINE_POLICY_OVERRIDES for same-build
knob A/B, which made the controlled arms possible).

| arm | build | new knobs | infra | rounds | wins | kills/deaths |
|---|---|---|---|---|---|---|
| baseline | old code | — | clean | 11 | 2 (18%) | 13/10 |
| pass3 | new | all ON | heavy storms | 11 | 0 (0%) | 5/11 |
| control | new | all OFF | mild | 11 | 3 (27%) | 8/10 |
| pass3b | new | all ON | clean | 7 | 0 (0%) | 1/7 |
| pass3c | new | **endgame OFF**, gank+shove+bounty ON | clean | 11 | **4 (36%)** | 2/10 |

**Endgame posture: measured harmful, reverted to default-off.** Pooled:
endgame-ON arms 0/18 wins; endgame-OFF arms 7/22 (Fisher p≈0.01). Telemetry
attribution: the trade gate was NOT the problem (122/122 trade decisions in a
sampled round were "engage" — it never fired); the center-hold displaced the
hunting behaviors (`searchLastSeenEnemy`/`followHint`) for much of each round
because this arena's ~60s rounds shrink into "endgame" radii quickly, so the
bot camped instead of fighting (engage share 16-30% of alive ticks vs 25-71%
in control). `endgameZoneRadius` default 12 → **0**; code path and knobs kept
(Tuner-explorable), smoke tests pin the knob on.

**Gank anticipation + shove interrupt + bounty targeting: kept.** pass3c
(these on, endgame off) was the best arm at 36% vs control 27% vs old-code
baseline 18%. Not statistically significant at N=11 (4/11 vs 3/11), but the
direction is positive, sim was neutral-to-positive, and each is individually
knob-disableable. Note the changed win style: pass3c won by outliving (2
kills across 11 rounds) — consistent with gank anticipation steering the bot
out of doomed fights in a snowbally lobby.

**Session-level caveats, stated plainly:**
- N=11 per arm is small; 18%→36% is directionally encouraging, not proven.
  The outcome log + variant tags + env overrides make re-running this
  comparison a one-liner per arm.
- ELO across the session fell (969→~290) because the experiment kept playing
  losing arms (pass3/pass3b at 0%) and the evening lobby contained snowballing
  killers (Fortress, Valkyrie). ELO is not comparable across arms — win rate
  per arm is the metric.
- Brain-side features (opponent-profile loadout counter-picking, bounty
  prompts, modifier tactics, disk memory) were smoke-validated only — no
  OpenRouter key exists in this environment, so no live LLM rounds.
- `ticksSurvived` in the outcome log is inflated for the first round of each
  process run (server tick counter is global); correct from round 2 on.
