# Engine audit, second pass — Phase 4: fixes implemented

All six Phase 3 findings, implemented one behavior module at a time, each verified with
`npm run typecheck` + `npm run smoke` (19 new assertions, 168 total, all green). No
`controller.ts` priority reordering (the only controller change is the pass-2
instrumentation choke point wrapping the unchanged cascade). Every new constant is an
`EnginePolicy` field with `mergePolicy()` clamping, exposed to the Tuner via
`PolicyPatchSchema` + prompt.

| # | Fix | File(s) | New `EnginePolicy` fields |
|---|---|---|---|
| 1 (M1) | Dagger flank: behind tile derived from `target.facing` (the field `rear_exposed` is defined by), and the in-range deferral is **bounded** by a consecutive-tick streak so it terminates in a head-on attack instead of orbiting | `movement.ts` (`flankingPosition`), `combat.ts`, `gameState.ts` (`noteFlankDefer`) | `flankMaxDeferTicks` (6, [0,30]; 0 = never defer) |
| 2 (S1) | Ranged fire-while-kiting: a retreat tick with the weapon ready and the chaser inside range (but not point-blank) fires instead of moving — bow/staff (staff leads with `attackAt`), never melee | `survival.ts` (`retreatAndHeal`) | `retreatFireWhileKiting` (true) |
| 3 (C1) | Gravity-well gate: believed collected charges (GameState bookkeeping fed by the decide() choke point: `use_item` on a gravity pickup +1, `use_gravity_well` −1) instead of "a pickup entity is visible on the ground" | `combat.ts` (`tryGravityWell`), `gameState.ts` | — (`staffGravityWell` toggle already existed) |
| 4 (C2) | Shove respects its 1.5s server cooldown at all three call sites (cooling-window, spear-brace, cornered separation), self-tracked via `gs.shoveReady()`; when not ready each site falls through to its existing next-best option (threat-aware step / spacing / grapple) | `combat.ts`, `survival.ts`, `gameState.ts` | — (15 ticks is a server constant, not tuning) |
| 5 (C3) | Spear brace-wait holds spacing itself (threat-gradient step, then plain step-away) instead of returning null — which the cascade guarantee turned into `positionForCombat` walking INTO the braced enemy | `combat.ts` | — (`spearBraceWait` toggle already existed) |
| 6 (T1) | `scoreEnemy`'s trade-advantage term reads a policy weight instead of a hardcoded ×30 | `targeting.ts` | `targetTradeWeight` (30, [0,100]) |

Defaults reproduce prior behavior where the prior behavior was correct (fix 6 is
default-identical; fixes 1-5 ARE behavior changes — that's the point — each covered by a
dedicated smoke assertion built around the exact failure observed in Phase 2).

## Validation

Same-seed before/after, 18 rounds per weapon (6 policy configs × 3), harsh 1v5 sim:

| Weapon | Metric | Pre-fix | Post-fix |
|---|---|---|---|
| daggers | wins (best config) | **0%** (every config) | **33%** (4 of 6 configs) |
| daggers | dmgDealt avg | **0** (every config) | 60–159 |
| daggers | attack actions (sampled round) | **0**/185 ticks | 13 |
| bow | wins (aggressive+dodge) | 33% | 67% |
| bow | dmgDealt range | 152–196 | 174–239 (top-2 configs still 100% win) |
| bow | heavy-retreat rounds | all losses, 5–9 attacks | fires while kiting; **won a round at 62% retreat share** (structurally impossible pre-fix) |
| sword | all configs | — | **bit-identical to pre-fix** (deterministic seeds; no regression on the pass-1-hardened path) |

Smoke additions that would have caught the originals: flank tile from facing + null when
already behind; **deferral terminates in an attack within `flankMaxDeferTicks`+1 ticks**
(the pass-1 suite only asserted a single tick's deferral, which is exactly how the orbit
slipped through); retreating bow fires when ready / kites when cooling / never at
point-blank / never as melee / toggle off restores old behavior; shove not re-issued
inside 15 ticks on the same GameState; uncollected gravity pickup does not cast, collected
charge casts once; spear vs braced enemy neither attacks nor closes distance; mergePolicy
clamps for all three new knobs.

## Notes / carried items

- C2's cooldown constant (15 ticks) and the believed-gravity-charge model are
  **optimistic client-side bookkeeping** — if the server rejects a shove we counted, we
  under-shove slightly (safe direction). `self.last_action_result` is still unread; a
  future pass could reconcile beliefs against it (flagged in pass2-phase1 as the one
  live-data question static reading can't settle: melee range semantics for diagonals).
- Proactive mine zoning, pickup threat-gradient, emergency-dodge candidate widening:
  carried again — evidence still doesn't justify them (dodge accuracy remained 0
  hit-despite-lowest-danger across all pass-2 runs).
- The sim fidelity fixes (SIM_WEAPON, SIM_PICKUPS, shove cooldown, gravity charge
  rejection) are permanent upgrades: future sweeps exercise all weapon paths, not just
  sword.
