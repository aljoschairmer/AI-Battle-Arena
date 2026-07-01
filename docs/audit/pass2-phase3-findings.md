# Engine audit, second pass — Phase 3: root-cause ranked findings

Ranked by estimated win-rate impact. Severity scale: blocks wins outright / degrades
trades / minor inefficiency. Classification: logic bug vs tuning gap (per the brief,
tuning gaps get an `EnginePolicy` knob check before any code fix).

## 1. Daggers flank orbit — daggers deal zero damage (M1)

- **Decision points:** `flankingPosition` (movement.ts:324-335), `combatBehavior` dagger
  deferral (combat.ts:73-78).
- **Evidence:** Phase 2: 18/18 daggers rounds, 0 kills, 0 damage dealt, 0 attack actions
  issued (88 engage-priority ticks in the sampled round produced only moves). Phase 1
  static: the docstring defines "behind" as opposite the target's facing; the code never
  reads `facing` and instead picks a tile perpendicular to our own approach axis, so
  arriving at the tile moves the goalposts and re-arms the pass-1 deferral every tick.
- **Why it loses fights:** a daggers loadout — which the Brain's loadout agent favors
  whenever bow/staff dominate the lobby (hard-counter +2) — cannot deal damage at all.
  It also *feeds* kills to opponents while orbiting. This is a regression introduced by
  pass 1's fix #3 interacting with the pre-existing facing bug.
- **Severity: blocks wins outright** (whole loadout archetype disabled).
- **Classification: logic bug**, two-part: wrong geometry (ignore `facing`) + missing
  termination (nothing bounds consecutive deferrals). Fix needs a new knob for the
  termination bound (`flankMaxDeferTicks`), clamped via `mergePolicy()`.

## 2. Ranged retreat never returns fire (S1)

- **Decision point:** `retreatAndHeal` (survival.ts:285-335) — only ever emits moves.
- **Evidence:** Phase 2: every bow loss spent 17.7–76.1% of ticks retreating (wins ~0%),
  firing 5–9 attacks per whole round; worst round 298 retreat ticks vs 8 attacks. The
  retreat rung outranks engage, so while it holds the tick a bow/staff never attacks —
  even a chaser 4 tiles inside our range, with our weapon ready, gets a free chase.
- **Why it loses fights:** retreat ticks are pure loss for ranged loadouts: no damage,
  no deterrence, chaser closes at equal speed. Kite-and-fire is the entire ranged
  archetype; the engine implements the kite (threat-gradient step) but never the fire.
- **Severity: blocks wins for ranged loadouts** (the dominant loss mode in the data).
- **Classification: logic bug** (missing action path). New knob:
  `retreatFireWhileKiting` toggle so the Tuner can disable it if firing-while-fleeing
  proves counterproductive in some meta.

## 3. Gravity-well gate inverted (C1)

- **Decision point:** `tryGravityWell` (combat.ts:158-175).
- **Evidence:** Phase 1 static: gate = "a gravity pickup entity is visible on the
  ground", but the spec requires a **collected** charge. Phase 2: rejected-cast spam
  observed (4 casts, runs of 2, at priority 6 which preempts combat); the collected-charge
  direction is structural — after collection the entity vanishes, so a real charge can
  never be spent.
- **Severity: degrades trades** for staff/grapple (wasted ticks in combat range;
  gravity-well item value is 100% discarded).
- **Classification: logic bug.** Fix uses the new `GameState` believed-charge tracking
  (collected − spent), no new knob needed (`staffGravityWell` toggle already exists).

## 4. Shove issued inside its 1.5s cooldown at all three call sites (C2)

- **Decision points:** cooling-window shove (combat.ts:85-92), spear-brace shove
  (combat.ts:40-43), cornered `createSeparation` shove (survival.ts:377).
- **Evidence:** Phase 1 static + spec: shove cooldown 1.5s, untracked anywhere
  client-side; the cooling branch re-issues shove every tick of a 5–16-tick cooldown
  window whenever posture is aggressive (a routine Tactician output) or the target is
  near a wall. Every rejected shove is a tick spent standing point-blank doing nothing —
  specifically *instead of* the threat-aware step-away coded two lines below it. Not
  sim-reachable pre-fix (sim modeled no shove cooldown at all — fixed this pass);
  `self.last_action_result` (which would have revealed the rejections live) is received
  every tick and read by nothing.
- **Severity: degrades trades** (damage eaten during cooldown windows; for the cornered
  separation case, standing still in a confirmed-losing trade).
- **Classification: logic bug** (missing state, wrong assumption "shove is always
  available"). No new knob — 15 ticks is a server constant, tracked in `GameState`.

## 5. Spear brace-wait is undone by the movement layer (C3)

- **Decision point:** combat.ts:38-44 `return null` → controller falls to
  `positionForCombat` → melee branch `moveTo(lead)` walks into the braced enemy.
- **Evidence:** Phase 1 static (cascade guarantee: rung 7 always ends with
  `positionForCombat` when combat declines). Not sim-reachable (`brace_ready` never set).
- **Severity: degrades trades** when facing spears (walks into the exact counter the
  branch exists to avoid); low frequency but the behavior is precisely inverted.
- **Classification: logic bug** (null means "defer", not "hold" — the branch needs to
  emit its own spacing action). Existing `spearBraceWait` toggle covers tunability.

## 6. Trade-advantage targeting weight is the last hardcoded weight (T1)

- **Decision point:** targeting.ts:128 `tradeAdvantage(ctx, e) * 30`.
- **Evidence:** Phase 1 static: every sibling weight in `scoreEnemy`
  (`targetLowHpWeight`, `targetCloseWeight`, `targetThreatAversion`,
  `targetMatchupWeight`, `targetSwitchHysteresis`) is a live-tunable `EnginePolicy`
  field; this one isn't — same oversight class as pass 1's hardcoded `0.6`.
- **Severity: minor inefficiency** (right logic, fixed constant).
- **Classification: tuning gap** — fix is exposing `targetTradeWeight` (default 30,
  clamped), no logic change.

## Ruled out / carried unchanged

- Emergency-dodge candidate narrowing: still 0 hit-despite-lowest-danger in all new runs
  — stays deprioritized.
- Proactive mine zoning, pickup threat-gradient: carried Tier-3, unchanged evidence.
- Charged-shot interrupt economy: still no client-visible windup; unchanged.
- Target thrash, zone-return threat-blindness, static retreat threshold, matchup-blind
  targeting: pass-1 fixes verified still in place and effective (sword win rates in the
  same harsh sim rose from ~6% pre-pass-1 to 67–100% in defensive/balanced configs).
