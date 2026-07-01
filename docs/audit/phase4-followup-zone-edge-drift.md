# Follow-up deep dive — zone-edge-drift vs. combat oscillation

`phase4-fixes.md` flagged this as measured-but-deliberately-unfixed: 27% of engagement
sequences were being interrupted by `survivalBehavior`'s zone-edge-drift branch, but nothing in
the telemetry said whether that interruption actually cost fights, and the risk of getting it
wrong was asymmetric (zone damage compounds if ignored; a missed combat tick doesn't). This
doc is the deep dive that resolved it.

## Step 1 — get the missing evidence before designing anything

The gap called out in `phase4-fixes.md` was combat-outcome data: does an interrupted engagement
actually lose more HP than an uninterrupted one? This didn't need new instrumentation — every
`tick_decision` event already carries `hp`, so episode-level HP deltas were computable directly
from the existing 144-round telemetry sample by walking the tick stream and grouping contiguous
`engage_target` runs (with a single sandwiched `zone_edge_drift` tick still counting as the same
episode).

Result, pre-fix:

| | n | avg HP lost / episode | HP lost / tick | avg episode length |
|---|---|---|---|---|
| Interrupted | 175 | 34.40 | 1.513 | 22.74 ticks |
| Uninterrupted | 121 | 32.90 | 2.175 | 15.12 ticks |

Reading this honestly: total HP lost per episode was almost the same (~5% worse when
interrupted) — not the smoking gun the frequency alone suggested. But interrupted episodes took
**50% longer** to resolve for essentially the same damage. Every interruption tick is a tick not
spent attacking, which mechanically drags out time-to-kill — a real, direct, low-confound
mechanism (unlike the per-tick HP rate, which is likely confounded by *where* near-edge fights
happen to occur, not a causal effect of the interruption itself).

This is a case for a bounded, safety-preserving fix, not a strong case for removing the zone
check.

## Step 2 — the fix: graduated margin, not a removal

`zoneEdgeMargin` (the existing single threshold, default 5) is now the *outer* edge of a soft
band. A new field, `zoneEdgeHardMargin` (default 2), is the inner floor:

- **Inside the hard margin**: always drift. No exception, no fight is good enough to skip it.
  This is the property that actually matters for not dying to the zone, and it's untouched —
  verified by a smoke test where a trivially-winning adjacent fight still yields a drift.
- **Between the hard floor and the soft margin**: defer to an active fight, but only if it's not
  a losing one (`tradeAdvantage(...) >= policy.minTradeAdvantage`, reusing the same threshold
  the disengage gate already uses — no new trade-math concept introduced). Falls through to
  `null`, letting the normal cascade (priority 7, `engage_target`) claim the tick.
- Re-evaluated every tick, so the instant the fight ends, turns bad, or the edge becomes urgent,
  drift resumes on its own — no separate timer or state needed.

One structural guarantee worth stating explicitly: `inAcceptableFight` only returns true when
`gs.enemies()` is non-empty, and `selectTarget` is proven (see `phase4-fixes.md`'s pickup-safety
section) to always return non-null whenever that's true. So deferring here can never strand a
tick doing neither combat nor zone safety — priority 7 is guaranteed to claim it.

Implementation: `src/engine/behaviors/survival.ts` (`inAcceptableFight`, reusing
`nearestAttacker`/`tradeAdvantage` already imported for other fixes), `src/types/internal.ts`
(`zoneEdgeHardMargin`, clamped `[0,20]` and additionally `Math.min`'d against `zoneEdgeMargin`
at the call site so the two can never be tuned into an inverted, nonsensical band). Three new
smoke assertions cover all three branches (urgent always drifts, soft-band-with-fight defers,
soft-band-without-fight still drifts).

## Step 3 — re-measure at scale, don't just trust the reasoning

Re-ran the full 144-match sweep with the same seeds used throughout this audit.

| Metric | Before this fix | After |
|---|---|---|
| Win rate | 20/144 (13.9%) | **57/144 (39.6%)** |
| Avg kills/match (sweep table) | 0.13–0.38 | **1.25–1.46** |
| Avg damage dealt/match | 95–124 | **164–210** |
| `survive_zone_hazards` tick-share | 24.3% | 13.8% |
| `retreat_heal_mine` tick-share | 22.5% | 19.4% |
| Target-switch thrash (secondary effect, not directly targeted) | 24.9% | 3.2% |
| Bad engages | 0.7% | 0.7% (unchanged) |
| Dodge hit despite min-danger tile | 0/144-round sample | 0/167 (unchanged) |

This is a much larger effect than the duration-cost reasoning alone predicted, and worth being
honest about *why* rather than just reporting the win. The likely mechanism: this simulator is
a 1-vs-5 free-for-all, where kill efficiency compounds — interrupting an attack doesn't just
cost one proportional tick, it can break weapon-cooldown rhythm and force re-approaches,
and every extra tick a fight drags on is an extra tick of exposure to the other four bots and
the still-shrinking zone. A ~50% duration increase across most fights, in a format where
finishing fights fast is close to the central skill, compounds into something much bigger than
a linear per-tick HP model would suggest. The target-switch thrash drop (24.9%→3.2%) wasn't
targeted by this fix at all — it's a plausible downstream effect of fights resolving fast and
decisively, leaving less time for scores between multiple visible enemies to drift into
thrash-triggering territory.

Sanity checks against the concern this could be a regression in disguise: `survive_zone_hazards`
didn't drop to zero (13.8%, a sane, non-degenerate value — confirms the hard floor is still
firing, not bypassed), average survival-tick counts in the sweep stayed in the same 140–181
range as before (bots aren't just "surviving longer by avoiding the zone entirely"), and the
sweep's own independently-tracked win/loss numbers agree with the telemetry-derived win/loss
count (39.6% vs. the sweep table's 33–46% per-config range) — two independently-computed
metrics cross-checking to the same story.
