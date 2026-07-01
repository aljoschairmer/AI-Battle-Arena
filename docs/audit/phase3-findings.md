# Phase 3 — Root-cause ranked findings

Ranked by estimated win-rate impact (not code messiness), synthesizing the static trace
(`phase1-behavior-trace.md`) with the empirical observations (`phase2-telemetry-observations.md`).
Each finding states: decision point, evidence, why it loses fights, severity, and whether it's a
**logic bug** (wrong condition / missing check / stale data — needs a code fix) or a **tuning
gap** (right logic, bad constant — check whether an `EnginePolicy` knob already covers it before
touching code).

## Executive summary

The single best-evidenced problem is not any one bad decision — it's that the engine's "get to
safety" path is a chain of individually-plausible pieces that don't add up to actually reaching
safety: the highest-priority survival rung is the *only* major movement decision in the engine
with zero threat-field awareness, it structurally preempts the reactive dodge, the retreat
trigger itself never asks whether retreating is working, and none of the engine's separation
tools (grapple, shove) have a defensive use path at all. Phase 2 shows this cluster consuming a
plurality of every losing round's ticks (42.1% average, up to 75%) and effectively none of the
one win's. Target-switch thrash and the dagger dead-code bug are the next tier: both are
confirmed logic bugs with clear, contained fixes. Everything else is either a smaller, more
speculative effect or explicitly ruled out by the evidence — those are listed at the bottom so
Phase 4 doesn't spend effort re-litigating them.

---

## Tier 1 — best-evidenced, likely blocks wins outright

### 1. The retreat/survival loop can reliably enter but not reliably escape

**Decision points:** `survivalBehavior` zone-return (`survival.ts:25-27`, priority 2, highest
in the whole pipeline), `retreatAndHeal` trigger (`survival.ts:152-153`), `combatBehavior`'s
cooldown step-away (`combat.ts:87`), grapple/shove universal specials (`combat.ts:96-130`).

**Evidence:**
- *Phase 1 (static):* the zone-return branch that outranks everything, including
  `emergencyDodge`, is the least threat-aware code in the engine — a raw `moveTo(zone_center)`
  with no `threatField()` call at all (survival.ts #1). Because `Controller.decide()` is a
  strict cascade, this means **a bot stepping back into zone with a charged shot lined up on it
  will not dodge that tick.** `retreatAndHeal`'s trigger is a static HP fraction that never
  consults `combatMath.tradeAdvantage()` (survival.ts #6) — it can't retreat earlier against a
  bad matchup or later against a good one. Once retreating, `combat.ts`'s cooldown step (line
  87) steps away from only the current target, ignoring every other enemy (combat.ts #6), and
  grapple/shove — the engine's only two tools that could create real separation or break line of
  sight — are used **exclusively offensively** everywhere in the codebase; the one defensive use
  the code's own docstring promises ("grapple-to-position to escape hazards", combat.ts:18) was
  never implemented (combat.ts #7).
- *Phase 2 (empirical, 18 rounds / 3,060 ticks):* `retreat_heal_mine` claimed **0%** of ticks in
  the one win and **42.1%** of ticks across the 17 losses (75.4% / 59.2% in the two losses run
  under shipped-equivalent defaults specifically). This is the single starkest number in the
  whole dataset.

**Why it loses fights:** the bot spends a plurality of every losing round's ticks trying to
disengage, and the mechanics available to it while doing so — threat-blind pathing at the
highest priority, a trigger oblivious to whether the fight is winnable, single-target-only
evasion while cooling down, and zero tools for actively creating separation — mean "retreating"
frequently doesn't translate into "getting away." A bot that's chosen to flee but structurally
can't disengage burns time that a bot committed to fighting or a bot that actually escaped would
have spent more productively either way.

**Severity: blocks wins outright.** Best-evidenced finding in the audit by both static and
empirical evidence.

**Classification: logic bug**, not tuning. No `EnginePolicy` knob controls whether zone-return or
the cooldown step consult the threat field, or whether grapple/shove have a defensive path —
these are missing code paths, not misconfigured constants. Tuning *can* reduce how often retreat
triggers (`Directive.hpRetreatFraction`, Brain-controlled, not a Tuner/`EnginePolicy` field at
all today) but cannot fix whether retreat *works* once triggered.

---

### 2. Target selection has no debounce, and thrash is confirmed in play

**Decision point:** `selectTarget` (`targeting.ts:13-45`), re-run statelessly every tick.

**Evidence:** Phase 1 confirmed zero persisted state anywhere (`targeting.ts` #3) — the function
is documented as "pure function of the current frame." Phase 2 measured this directly: 82 target
switches across 18 rounds, 24.4% of them under 500ms apart; 11 of 18 rounds individually crossed
the analyzer's own 30% thrash-flag threshold.

**Why it loses fights:** every switch restarts `positionForCombat`'s dagger-flank maneuver and
lead-point pursuit from scratch against the new target (movement.ts #3), so a bot oscillating
between two similarly-scored enemies makes net-negative progress toward either one. (Note: bow
charge is a self-resource, not bound to a target id, so — contrary to the audit brief's initial
hypothesis — thrash does not literally waste a charged-shot windup; the measured cost is
movement/flank progress, not charge economy.)

**Severity: degrades trades**, compounding over the course of a fight rather than losing it in
one tick.

**Classification: logic bug.** No `EnginePolicy` knob covers "minimum ticks between switches" or
"minimum score delta required to switch" — this doesn't exist as a tunable today. A fix needs
both new logic and a new knob (e.g. `targetSwitchMinTicks` / `targetSwitchHysteresis`).

---

## Tier 2 — degrades trades, contained fixes

### 3. Dagger backstab positioning is dead code

**Decision point:** `combat.ts:66-70`.

**Evidence:** `if (weapon==="daggers" && !target.rear_exposed && d<=1.5) { /* comment only */ }`
— empty block, falls through unconditionally to the plain attack at line 72. The real flank
logic lives in `movement.ts:29-34` but is only reachable when `combatBehavior` returns `null`,
which never happens while in range + weapon ready. Daggers always attack head-on the instant
they're in range, capturing the backstab bonus (`weapons.ts: backstab:true`) only if a flank
that started while still out of range happens to finish in time.

**Why it loses fights:** daggers are specifically the hard-counter weapon against bow and staff
(+2 matchup, `matchups.ts:15`) — the archetype's entire value proposition depends on landing the
backstab bonus consistently. This dead code caps that at "opportunistic, mostly not."

**Severity: degrades trades — high when playing daggers, specifically.** Not measurable in this
audit's Phase 2 pass: the offline simulator always equips "ours" with a sword (`scripts/simulate.ts:210`),
so this bug was never exercised by the telemetry run. Confidence is from Phase 1 static
evidence only; recommend a targeted daggers-loadout simulation before/after the fix to confirm
magnitude.

**Classification: logic bug**, and a cheap one — `policy.daggerFlank` already exists as a toggle
for the movement-side logic; the fix is making `combatBehavior` respect that same toggle instead
of unconditionally attacking, not introducing a new knob.

---

### 4. Healthy bots never consult trade math before engaging, and the gate that would is hardcoded

**Decision points:** `controller.ts` engage branch (trade-check only runs when
`gs.hpFraction() < 0.6`), `targeting.ts:78` (`tradeAdvantage * 30` inside a score that also
awards up to ~94 from HP/closeness/openings alone).

**Evidence:** Phase 1 confirmed trade advantage is present in target scoring but easily
dominated, and is never consulted for the *engage decision itself* above 60% HP (by explicit
design — see the comment at the original `controller.ts:105-108`). Phase 2's now-unconditional
trade logging (a Phase 2 instrumentation change, not a behavior change) shows the mechanism firing
exactly as predicted: 613/614 target-selected ticks resulted in `"engage"`, one `"disengage"`,
zero `"hold"`. 27 of 613 engagements (4.4%) had negative predicted advantage — but averaging only
-0.039, and concentrated entirely in one experimental sweep config; the 3 rounds run under
shipped-equivalent defaults show **zero** bad engages in this sample.

**Why it loses fights:** the architectural gap is real and reproducible, but this sample doesn't
show it costing much at current tuning — likely because `minTradeAdvantage` (default -0.3) is
loose enough that most engagements clear it anyway, and/or HP rarely drops below 0.6 while
facing a severely negative trade in these specific runs. The latent risk (a healthy bot walking
into a heavily negative trade, e.g. a 1v3 gank, without ever checking) is architecturally
possible and not disproven, just not what this sample happened to hit.

**Severity: degrades trades, magnitude unconfirmed** — recommend re-measuring after fix with a
scenario that forces more simultaneous-enemy pressure before ranking this higher.

**Classification: mixed.** The `0.6` HP gate is a **raw hardcoded constant in `controller.ts`,
not read from `EnginePolicy` at all** — inconsistent with every other threshold in the same
function (`minTradeAdvantage`, `dodgeEagerness`, etc.) being live-tunable. That's a pure
oversight worth fixing regardless of the finding's severity — expose it as a new
`EnginePolicy` field so the Tuner can adjust it live, matching the pattern already established
for every sibling threshold. Whether to *also* trade-check healthy engagements is a logic
decision, not something any existing knob can express.

---

### 5. Weapon-matchup knowledge is fully built but never consulted by targeting

**Decision point:** `targeting.ts:47-86` (`scoreEnemy`).

**Evidence:** Phase 1 confirmed `matchups.ts`'s `WEAPON_MATCHUPS` (±2 range) is never imported
by `targeting.ts`, despite enemy weapon type being known every tick with zero uncertainty (Phase
0 finding — no fog-of-war ambiguity here, unlike trade math which has to guess at incoming DPS).
Not independently isolated in the Phase 2 pass — the sim does vary opponent weapons
(`oppWeapons: ["sword","bow","daggers","spear","staff"]`), but the aggregate wasn't sliced by
"was a hard-counter matchup available and ignored," so this remains a static-only finding.

**Why it loses fights:** when two visible enemies are similar in HP/distance, the ±2 matchup
swing (e.g., our daggers vs. their bow or staff) is invisible to target selection — the tie could
break toward the worse matchup for reasons entirely unrelated to who's actually easier to kill.

**Severity: degrades trades, plausible but unquantified.**

**Classification: logic bug.** No knob covers this; a fix adding a matchup term to `scoreEnemy`
needs a **new** `EnginePolicy` weight (e.g. `targetMatchupWeight`) per the audit's own
constraint that new magic numbers must be tunable.

---

## Tier 3 — minor inefficiency or unresolved

| # | Finding | Evidence | Severity | Classification |
|---|---|---|---|---|
| 6 | Mine placement is reactive-only and not bearing-aware (survival.ts #8) | Phase 1 static only — `maybeDropMine` only reachable from inside retreat, proximity-gated not direction-gated | Minor — capped at 3/round, small blast radius | Logic gap; low priority given scope-to-severity ratio |
| 7 | `emergencyDodge`'s candidate set is narrower than the threat field's own full scan (survival.ts #5) | Phase 1 static concern; Phase 2 did **not** reproduce it (0/18 hit despite true-minimum tile) | Low confidence either way, small N | Logic gap, but evidence doesn't currently support prioritizing a fix |
| 8 | Pickup safety check is a flat radius, not the threat gradient (movement.ts #5) | Phase 1 static only | Minor — lowest-priority behavior in the whole pipeline | Logic gap, low priority |
| 9 | Zone-edge drift (survival.ts #2) may oscillate against an in-progress engage | Phase 1 static/plausible; Phase 2's `tick_decision`/`fellThrough` data could answer this directly with a targeted query but wasn't specifically mined for it this pass | Unknown — plausible, not measured | Open question, not a confirmed finding |

---

## Ruled out — no Phase 4 action needed

Confirmed by Phase 1 and/or Phase 2, listed so effort isn't wasted re-checking them:

- **Emergency dodge is not the "away from nearest enemy" anti-pattern** — it's genuinely
  threat-field-ranked (survival.ts #5), and Phase 2 shows 0/18 dodges hit despite landing on the
  true safest tile.
- **Kite distance is per-weapon**, not a constant (movement.ts #2, `preferredRange` from
  `weapons.ts`).
- **Spear brace-wait, shield disrupted-bash, staff cluster/gravity-well tactics** are all
  genuinely implemented, not one generic path (combat.ts #3/#4/#5).
- **Leading is wired into every attack call where the action schema supports it** (staff's
  `target_position` AoE) — other weapons' `attack()` has no position parameter to lead in the
  first place, so this isn't a gap (targeting.ts #4).
- **Stale fog positions are never used for combat targeting**, only for the lowest-priority
  "search" fallback when no enemies are visible at all (targeting.ts #5).
- **"Hold ground" and "engage" cannot literally fight each other tick-to-tick** — structurally
  mutually exclusive by the priority cascade (movement.ts #4).
- **Charged-attack interrupt risk** remains genuinely inconclusive — no client-visible windup
  state machine exists to confirm or deny a real cost either way; not reproducible from this
  codebase or this simulator (server-side behavior, out of scope for a client-side audit).

---

## Cross-check against Phase 4's constraints

- Findings #1 (partially), #2, #3, #5 all fit inside existing behavior modules — no
  `controller.ts` priority reordering required for any of them.
- Finding #1's "should zone-return ever defer to dodge" question is the one place a priority-order
  discussion is unavoidable; the recommended shape (make `survivalBehavior` itself check for an
  imminent-hit condition before committing to a plain zone-return move, rather than reordering
  priorities 2 and 3) avoids restructuring `decide()`'s cascade — flagged explicitly for Phase 4
  review before implementation, per the constraint to call out any such change rather than do it
  silently.
- New tunables required: `EnginePolicy.disengageHpThreshold` (finding #4, replaces the hardcoded
  `0.6`), `EnginePolicy.targetMatchupWeight` (finding #5), `EnginePolicy.targetSwitchMinTicks`
  and/or a score-delta hysteresis constant (finding #2). All go through `mergePolicy()` clamping
  like every existing knob.
