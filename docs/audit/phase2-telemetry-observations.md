# Phase 2 — Instrumentation and observations

## What was wired in

`src/engine/telemetryLog.ts` and `scripts/analyze-telemetry.ts` were dropped in as provided,
with one deliberate deviation and one necessarily-invented piece, both called out inline in
`telemetryLog.ts`'s header comment:

- **`PriorityName` gained two members** (`cant_act`, `gravity_well`) — the real controller
  pipeline has 9 rungs, not the 6 the audit brief's summary described (Phase 0/1 finding).
  Mapping `gravity_well` claims into `engage_target` would have quietly corrupted the
  priority-distribution stat; extending the union is purely additive and the analyzer's
  generic `Map<string,number>` counting doesn't care.
- **Target-switch tracking required new state** — `selectTarget()` was previously a stateless
  pure function (confirmed in Phase 1: "no debounce" wasn't just an absence of a debounce
  *mechanism*, there was no *memory* of the prior target at all). Added `lastTargetId` /
  `lastTargetSwitchTick` to `GameState` (not module-level state in `targeting.ts`, which
  would cross-contaminate if multiple bot instances ever share a process — `coop.ts` implies
  they can).
- **`tradeEvaluated` is called from `controller.ts`, not `combat.ts`** — `combatMath.ts` is
  never imported by `combat.ts` (Phase 1 finding); the one and only consultation point is
  `controller.ts`'s engage branch. The advantage is now computed **unconditionally** whenever
  a target is selected (not only inside the previous `hp<0.6` gate), so telemetry can see what
  trade math predicted for every engagement — otherwise the exact bug Phase 1 flagged
  (healthy bots never consult trade math) would make the "engaged despite predicted
  disadvantage" analyzer check permanently blind to that bug.
- **Dodge resolution is called from `Controller.decide()`, before the can't-act guard** — not
  nested inside `survivalBehavior` as the header comment's naive suggestion implied.
  `survivalBehavior` is unreachable on a dead/stunned/respawning tick, and a dodge that gets
  the bot killed or stunned immediately after is exactly the outcome this must not drop.
- **Dodge candidate comparison was widened to 8 directions for `minAvailableDanger`** (the
  live decision still only ever picks from `{perp, perpNeg, away}`, unchanged) — otherwise
  `chosenTileDanger` and `minAvailableDanger` are definitionally the same number in the
  existing code (the loop only ever tracks its own running minimum), making the analyzer's
  "hit despite choosing lowest-danger tile" check trivially compare a value to itself.

No behavior changed. `npm run typecheck` and `npm run smoke` both pass unmodified — every new
call is either a no-op behind `TELEMETRY_LOG` or a side-effect-free read (trade advantage is
now computed once and reused for both the decision and the log, so the engage branch is if
anything cheaper than before, not more expensive).

## How the data was generated

The repo already has a real offline self-play simulator (`scripts/simulate.ts`) that drives
the actual `Controller`/`GameState` — not a mock — against 5 baseline bots at once. Telemetry
hooks were added to its match runner (`setBotId`/`roundStart`/`roundEnd`), and `MATCHES` was
made overridable via `SIM_MATCHES` so a quick sample doesn't require running the full 144-match
sweep. Generated with:

```
SIM_MATCHES=3 TELEMETRY_LOG=1 npx tsx scripts/simulate.ts
npx tsx scripts/analyze-telemetry.ts logs/telemetry/*.jsonl
```

18 rounds, 3,060 decision ticks, 1 win / 17 losses.

**Two fidelity caveats, discovered by actually running it (not obvious from reading the
analyzer's code):**

1. **`scripts/simulate.ts`'s `buildTick()` never populates pickups, hazards, mines, or gravity
   wells** — `nearby_entities` is bots-only. `grab_pickups` and `gravity_well` show **0** claims
   across all 3,060 ticks, and `survive_zone_hazards`'s hazard/burn branches never fire (only
   its zone-boundary branches can). This is a simulator limitation, not evidence those systems
   are broken — Phase 1's pickup/hazard/mine findings remain **unvalidated by this pass**, not
   ruled out.
2. **Round "duration" and "switches/s" are meaningless for this simulator** — it runs a whole
   match in a tight synchronous loop, so `Date.now()` barely advances between `round_start` and
   `round_end` (some files show durations of a few ms for 100+ ticks). The **tick-based** ratios
   (`ticksSinceLastSwitch < 5`, priority-claim percentages, bad-engage fraction, dodge-hit
   fraction) are unaffected and remain valid — only the wall-clock-derived numbers the analyzer
   prints (e.g. "2500.00/s") are artifacts of sim speed, not real signal. This is worth fixing
   in the analyzer if it's ever pointed at simulated data regularly, but it isn't blocking here
   since the ratio-based stats are unaffected.

Given those, and the sim's specific 1-bot-vs-5-simultaneous-baselines scenario (a deliberately
harsh stress test per the script's own comment, not a literal model of live arena matchmaking),
the results below should be read as **mechanism-level evidence that Phase 1's hypotheses do
or don't manifest in play**, not as a literal live win-rate estimate.

## Results

### Priority claim distribution — the headline finding

| Priority | Overall (3,060 ticks) | The 1 win (162 ticks) | The 17 losses (2,898 ticks) |
|---|---|---|---|
| `retreat_heal_mine` | 39.9% | **0%** | 42.1% |
| `hold_ground_zone` | 22.8% | 11.1% | 23.5% |
| `engage_target` | 20.1% | 45.7% | 18.6% |
| `survive_zone_hazards` | 16.6% | 43.2% | 15.1% |
| `emergency_dodge` | 0.6% | 0% | 0.6% |
| `gravity_well` / `grab_pickups` / `cant_act` | 0% | 0% | 0% (sim fidelity, see above) |

The single win spent **zero** ticks in `retreat_heal_mine` and split its time almost entirely
between fighting (`engage_target`) and zone positioning (`survive_zone_hazards`). The losses
spent a plurality of all ticks (42.1%) retreating. Restricting to just the 3 rounds run under
the config closest to shipped defaults (`current(defaults)`: aggression 0.55, minTradeAdvantage
-0.1 — see caveat below) shows the same pattern even more starkly: 75.4% and 59.2%
`retreat_heal_mine` in the two losses, 0% in the win.

**Caveat on causality:** N=1 for wins is too small to prove retreating *causes* losses rather
than being a symptom of an already-bad 1v5 fight. But it's directionally exactly what Phase 1's
static finding predicts: `retreatAndHeal`'s trigger is a static HP fraction that never
re-checks whether retreating is actually working (getting away) versus just delaying a loss
against opponents the threat-blind `survivalBehavior` zone-return (priority 1, preempts dodge)
and single-target-only cooldown-step (`combat.ts` #6) can't reliably shake.

### Target-switch thrash — confirmed in play, not just in theory

82 switches total, 20 (24.4%) less than 5 ticks (500ms) apart. 11 of the 18 individual rounds
individually crossed the analyzer's own 30%-thrash flag threshold. This empirically confirms
Phase 1's static finding (`selectTarget` had zero persisted state) actually produces thrash
during real play, not just in the abstract.

### Trade evaluation vs. engagement — confirmed, but modest in this sample

613 of 614 target-selected ticks resulted in `decision: "engage"`; exactly **one** `disengage`
and **zero** `hold` across the entire sample. 27 of those 613 engagements (4.4%) had a
negative predicted advantage (avg **-0.039**, i.e. barely losing, not catastrophically).

This confirms the mechanism Phase 1 flagged — the `hp<0.6` disengage gate almost never fires,
and healthy-bot engagements are never trade-checked for the *decision* itself — but in this
specific sample the magnitude is small (all 27 bad engages clustered in one `balanced+` sweep
config's single round; the 3 `current(defaults)`-config rounds show **zero** bad engages). The
architectural gap is real and reproducible; whether it's currently costing meaningful win-rate
under the actual shipped policy, versus mostly being latent (would bite harder against an
opponent whose trade math is severely negative, not mildly), isn't resolved by this sample —
worth a larger/varied run before ranking it above the retreat-dominance finding.

### Dodge accuracy — hypothesis not reproduced in this sample

0 of 18 dodges were hit despite landing on the true minimum-danger tile across all 8 directions
(not just the 3 the live code considers). Combined with 0 unresolved dodges (confirming the
one-tick resolution wiring itself works), this is a mild, low-confidence data point *against*
Phase 1's "narrow candidate set" concern actually costing damage in practice — though N=18 is
too small to rule it out, and the sim's bots-only entity model means every dodge here was
evaluated against enemy coverage only, never hazards.

## What Phase 2 changes about the Phase 1 severity ranking

Going into Phase 3: the **retreat-dominance pattern** is now the best-evidenced, single
largest-looking issue (both by tick-share and by the stark win/loss contrast), ahead of
target-switch thrash (confirmed but smaller blast radius per-tick) and ahead of the
trade-evaluation gap (confirmed mechanism, modest measured magnitude so far). The
dagger-backstab dead code and the grapple/shove-never-defensive findings remain pure static
findings — this sim always equips "ours" with a sword, so neither is exercisable by this
observation pass at all.
