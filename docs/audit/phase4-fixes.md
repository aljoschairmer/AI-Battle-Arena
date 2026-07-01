# Phase 4 — Fixes implemented

All six fixes from `phase3-findings.md`, implemented one behavior module at a time, each
verified with `npm run typecheck` + `npm run smoke` (new assertions added per fix — 90+
assertions total, all green) before moving to the next. No `controller.ts` priority reordering
in any of them. Every new constant is an `EnginePolicy` field with `mergePolicy()` clamping.

| # | Fix | File(s) | New `EnginePolicy` fields |
|---|---|---|---|
| 1 | Retreat cluster: threat-aware zone-return, trade-aware retreat threshold, defensive shove/grapple when cornered | `survival.ts` | `retreatTradeSensitivity` (0, [0,0.4]), `disengageUseSeparation` (bool) |
| 2 | Cooldown step-away now threat-field-aware, not single-target | `combat.ts` | — (reuses `threatField()`) |
| 3 | Target-switch hysteresis (debounce) | `targeting.ts`, `gameState.ts` (new `currentTargetId()`/`noteTargetSelection()`) | `targetSwitchHysteresis` (15, [0,60]) |
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
- **Target-switch thrash did NOT improve (24.4% → 24.9%, statistically flat).** This is worth
  taking at face value rather than explaining away: the hysteresis fix is correctly implemented
  and unit-tested (it demonstrably suppresses small-margin flips in the smoke tests), but the
  aggregate thrash metric barely moved. The likely explanation — not yet confirmed — is that
  the analyzer's "<5 ticks apart" measure doesn't distinguish noise-driven oscillation between
  two persistent targets (what the fix targets) from legitimate rapid re-targeting in a chaotic
  5-enemy brawl (an enemy dying and a new best target needing to be picked the very next tick,
  which a debounce mechanism correctly should *not* suppress). Flagged as an open follow-up: a
  future telemetry pass could check whether switches revisit a *previously-held* target within
  a short window (true thrash) versus always moving to a *new* target (legitimate churn) before
  concluding the hysteresis margin (currently 15) needs to be raised.

Also unchanged, as expected: dodge-hit-despite-min-danger stayed at 0 (Phase 3 already flagged
this as unreproduced and low-priority — no fix was attempted for it, consistent with "don't fix
what the evidence doesn't support fixing").

## Explicitly not done in this pass

- The one priority-order judgment call flagged in Phase 3 (whether `survivalBehavior` should
  ever defer to `emergencyDodge` for an imminent-hit condition while also out-of-zone) was
  deliberately left alone — it would touch `controller.ts`'s priority cascade itself, which the
  audit's constraints require calling out explicitly rather than bundling into another fix.
  Zone-return is now threat-aware (reduces the frequency/severity of the interaction) but the
  structural preemption of dodge by survival-priority-2 still exists.
- Tier-3 findings from Phase 3 (mine placement direction-awareness, pickup-safety radius vs.
  gradient, zone-edge-drift-vs-combat oscillation) were not touched — Phase 3 ranked them low
  severity relative to implementation cost, and none had strong empirical support.
