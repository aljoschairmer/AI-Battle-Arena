# Phase 4 — Fixes implemented

All six fixes from `phase3-findings.md`, implemented one behavior module at a time, each
verified with `npm run typecheck` + `npm run smoke` (new assertions added per fix — 90+
assertions total, all green) before moving to the next. No `controller.ts` priority reordering
in any of them. Every new constant is an `EnginePolicy` field with `mergePolicy()` clamping.

| # | Fix | File(s) | New `EnginePolicy` fields |
|---|---|---|---|
| 1 | Retreat cluster: threat-aware zone-return, trade-aware retreat threshold, defensive shove/grapple when cornered | `survival.ts` | `retreatTradeSensitivity` (0, [0,0.4]), `disengageUseSeparation` (bool) |
| 2 | Cooldown step-away now threat-field-aware, not single-target | `combat.ts` | — (reuses `threatField()`) |
| 3 | Target-switch hysteresis (debounce) | `targeting.ts`, `gameState.ts` (new `currentTargetId()`/`noteTargetSelection()`) | `targetSwitchHysteresis` (30 — see below, [0,60]) |
| 4 | Dagger backstab dead code now actually defers to finish an in-progress flank | `combat.ts`, `movement.ts` (exported `flankingPosition`) | — (reuses existing `daggerFlank` toggle) |
| 5 | Hardcoded `0.6` disengage gate exposed as a tunable | `controller.ts` | `disengageHpThreshold` (0.6, [0,1]) |
| 6 | Weapon-matchup matrix wired into target scoring | `targeting.ts` | `targetMatchupWeight` (12, [0,40]) |

Every new default reproduces the prior hardcoded behavior exactly (e.g. `disengageHpThreshold`
defaults to `0.6`, matching what was hardcoded) — these are tuning surface additions, not
behavior changes by default, except where the fix's entire point *is* a behavior change (1, 2,
3, 4, 6), each covered by a dedicated smoke assertion built around a hand-derived scenario.

## Final validation

Re-ran the full 144-match self-play sweep (`npx tsx scripts/simulate.ts`, all 6 configs × 24
matches) with `TELEMETRY_LOG=1`, same harsh 1-bot-vs-5-simultaneous-baselines scenario as
Phase 2. Compared against the Phase 2 baseline (18 rounds, pre-fix):

| Metric | Phase 2 baseline (N=18) | Post-Fix-1-only (N=18) | Post-all-6-fixes (N=144) |
|---|---|---|---|
| Win rate | ~6% (1/18) | ~6% (1/18, same seeds) | **13.9% (20/144)** |
| `retreat_heal_mine` overall | 39.9% | 29.3% | **22.5%** |
| `retreat_heal_mine` in losses | 42.1% | 31.2% | **27.4%** |
| Target-switch thrash (<5 ticks apart) | 24.4% | — | 24.9% |
| Bad engages (predicted<0, engaged anyway) | 4.4% (27/613) | — | **0.7% (46/6,699)** |
| Dodge hit despite min-danger tile | 0/18 | 0/18 | 0/115 |

Caveat throughout: N=18 vs. N=144 aren't a clean equal-sample comparison — the small samples
are noisier. Treat the last column as the more statistically meaningful read, and the earlier
ones as directional corroboration, not a precise before/after delta.

**Two honest results, not just good ones:**

- **Retreat-dominance and bad-engage rate both improved substantially** — retreat tick-share
  down roughly a third, bad-engage rate down roughly 6×. Win rate against this specific harsh
  scenario roughly doubled (and went from "mostly 0% across small samples" to a stable,
  non-trivial rate against 5 simultaneous opponents).
- **Target-switch thrash barely moved at first (24.4% → 24.9%) — investigated, not just
  reported.** Follow-up: instrumented a diagnostic pass over the same telemetry that checks
  whether each fast (<5-tick) switch revisits a target held within the last 20 ticks (true
  A→B→A oscillation) versus always moves to a genuinely new target (legitimate churn, e.g. the
  old target died). Result: **70 of 160 fast switches (44%) were true oscillation** — the
  hysteresis mechanism itself is correct (it demonstrably suppresses small-margin flips in the
  smoke tests), but the default margin (15) was too small relative to how much
  `tradeAdvantage`'s gang-up term swings a candidate's score tick-to-tick as *other* enemies'
  cooldowns cycle in and out of the 5-tile gang-up radius — a volatility source separate from
  the thing the fix targets. Swept `targetSwitchHysteresis` empirically (15/30/45) on the same
  144-match sweep: 30 captured most of the achievable reduction (fast switches 160→136, true
  oscillation 70→56, several configs' win rates up) with diminishing returns beyond it (45 gave
  130/53, plus risk of over-tuning stickiness to this one scenario) — **default raised from 15
  to 30**. The residual ~53 oscillations are very likely mostly genuine multi-enemy volatility
  (a chaotic 5-enemy brawl where the objectively-best target really does change most ticks)
  rather than a further fixable bug, but flagged as a real possibility, not confirmed.

Also unchanged, as expected: dodge-hit-despite-min-danger stayed at 0 (Phase 3 already flagged
this as unreproduced and low-priority — no fix was attempted for it, consistent with "don't fix
what the evidence doesn't support fixing").

## Post-Phase-4 follow-ups

### survivalBehavior vs. emergencyDodge (the deferred priority-order call)

Implemented, without reordering `controller.ts`'s cascade. `survivalBehavior` now has one
narrow exception at its top: if `imminentHitTriggers` (a shared helper extracted from
`emergencyDodge`, covering only the "a charged shot is already committed and about to land"
case — deliberately *not* `emergencyDodge`'s broader reactive/pressure triggers like
`justHit`/`meleePressure`, which stay lower priority than environmental survival) finds
something and dodging is actually possible, `survivalBehavior` calls `emergencyDodge` itself
and returns its action directly. Priority 2 still runs first and still normally wins; this is
a targeted exception inside it, not a reorder of priorities 2 and 3.

Two things worth being precise about:

- **Telemetry attribution**: since `survivalBehavior` can now return a `dodge` action,
  `controller.ts`'s `tick_decision` logging checks the actual action type and logs it under
  `emergency_dodge`, not `survive_zone_hazards` — otherwise the priority-claim distribution the
  whole Phase 2/3 methodology depends on would silently mislabel these ticks.
- **Not exercised by the offline simulator**: `scripts/simulate.ts`'s `buildTick()` hardcodes
  every simulated enemy's `charged_shot_ready: false` and `bow_charge_level: 0` — the exact
  fields this fix's trigger depends on. The full-sweep numbers above are therefore identical
  before and after this specific fix; it's verified only by the new smoke assertion (a
  hand-built scenario: outside zone + a charged shot lined up + dodge ready → must dodge, where
  it previously couldn't even reach that branch), not by the simulation. Flagging this rather
  than implying the sweep numbers validate it.

## Explicitly not done in this pass

- Tier-3 findings from Phase 3 (mine placement direction-awareness, pickup-safety radius vs.
  gradient, zone-edge-drift-vs-combat oscillation) were not touched — Phase 3 ranked them low
  severity relative to implementation cost, and none had strong empirical support.
