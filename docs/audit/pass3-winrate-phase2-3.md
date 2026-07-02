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

`variant=pass3` batch: RUNNING — results appended below when complete.

<!-- PASS3-RESULTS -->
