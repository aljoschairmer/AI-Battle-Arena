# Engine audit, second pass — Phase 0: Orient

Context: the first engine audit (docs/audit/phase1…4) already shipped six behavior fixes
(threat-aware zone-return + trade-aware retreat + defensive shove/grapple, threat-aware
cooldown step, target-switch hysteresis, dagger flank deferral, `disengageHpThreshold`,
`targetMatchupWeight`). The bot still loses consistently, so this pass re-orients against
the **current** code and specifically hunts what the first pass never exercised: its own
Phase 2 admitted the simulator always equips sword and never spawns pickups/hazards, so
every dagger/bow/staff-specific path and the whole pickup/gravity subsystem were audited
statically only.

## controller.ts — the priority pipeline (current)

- Nine rungs, strict cascade, one action per tick (`decide()`, controller.ts:76-243):
  (1) can't-act → idle; (2) `survivalBehavior` (zone/hazard/burn, with one narrow
  exception where an imminent charged shot converts into a dodge); (3) `emergencyDodge`;
  (4) `retreatAndHeal` (+(5) mine-while-retreating folded into the same rung);
  (6) `gravityWellBehavior` (staff/grapple only); (7) engage: `selectTarget` →
  trade-gated `tacticalDisengage` bail → `combatBehavior` → `positionForCombat`;
  (8) `grabPickup`; (9) `defaultReposition`.
- A rung "claims" the tick by returning non-null; `combatBehavior` returning null while a
  target exists does NOT fall through to pickups — `positionForCombat` unconditionally
  claims it (controller.ts:222-228). So rung 7 always terminates the cascade when any
  enemy is visible. **Consequence: whatever `combatBehavior` declines to do, movement
  does — the two must agree, or movement silently undoes combat's intent** (see spear
  brace finding, Phase 1).
- The engage bail (`tacticalDisengage`) only runs when `hpFraction < disengageHpThreshold`
  (default 0.6, tunable) AND predicted advantage < `minTradeAdvantage`, and never against
  the Brain's pinned target (controller.ts:194-204). Healthy bots still commit by design.
- Rung 6 sits ABOVE engage: if `gravityWellBehavior` returns an action every tick, combat
  is completely preempted — its gating condition is therefore load-bearing (Phase 1 #C1).
- Telemetry (`tickDecision` with `fellThrough`, `tradeEvaluated`, dodge pair events) is
  already wired at every exit point from the first audit — reusable as-is for this pass.

## gameState.ts — what's known / not known per tick

- Known every tick with certainty: own full `SelfState` (incl. `weapon_ready`,
  `dodge_cooldown`, `grapple_charges/cooldown`, `facing`, effects, `last_action_result`,
  `hits_received`); every visible enemy's weapon, hp, `attack_range`, `can_attack`,
  `facing`, `brace_ready`, `bow_charge_level`, `charged_shot_ready`, `rear_exposed`,
  `is_dodging`, `has_los`, `threat_score`; zone geometry; pickups/hazards in fog.
- Tracked derivations: per-enemy velocity (`enemyVel`, clamped ±2/tick) for leading;
  `lastSeenEnemies` (30-tick memory, cleared on round transitions since the transport
  audit); per-tick cached `ThreatField`; target-selection memory for hysteresis.
- **Not tracked anywhere: our own action-economy state the server doesn't echo — shove
  cooldown (spec: 1.5s), gravity-well charges (spec: consumed pickup grants 1), and
  whether the last issued action was actually accepted (`last_action_result` is received
  but never read by any behavior).** Enemy cooldown state IS partially known
  (`can_attack`) and used; enemy dodge availability is not (unknowable).
- `hazardTiles()` includes our own visible mines (enemy mines are invisible per spec), so
  pathing avoids self-mines; `isSafeStep` = passable + not hazard-adjacent.

## threatField.ts + combatMath.ts — danger field and trade evaluator

- `ThreatField.build` (per tick, cached): window ≈ fog+3 ≤ 14 tiles; danger = enemy
  weapon coverage (flat inside `attack_range`, quadratic falloff outside, weighted by
  `threat_score` or profile DPS) + outside-zone gradient (60 + 4/tile) + hazard proximity
  (+50 within chebyshev 1). Consumers: `survivalBehavior` zone-return, `retreatAndHeal`
  kite step, `tacticalDisengage`, `emergencyDodge` landing choice, `combatBehavior`
  cooldown step. Movement's approach/strafe (`positionForCombat`) and pickup routing do
  NOT consult it — approach intentionally, pickups via discrete checks instead.
- `tradeAdvantage` (combatMath.ts:21-40): symmetric TTK comparison in (-1,1); our DPS
  from server-computed stats, enemy DPS from static per-weapon profile (their stats are
  unknowable); gankers within 5 tiles add 0.8× their DPS; our defense discounts incoming.
  Consulted at: controller engage bail, `retreatAndHeal`'s trade-scaled threshold,
  `survivalBehavior`'s soft zone-band "acceptable fight" check, and `scoreEnemy`
  (weight **hardcoded ×30** — the one trade-math weight not in `EnginePolicy`).

## derived.ts + matchups.ts — formulas and matchup matrix

- `derived.ts` mirrors the server Stat Simulator exactly (verified against published
  numbers); provides `fightPower`/`optimizeBuild` used for default loadouts. Engine-side
  combat reads server-echoed `loadout_confirmed.computed` in preference to these.
- `matchups.ts`: ±2 matrix from the Strategy tab; wired into targeting since pass 1
  (`targetMatchupWeight`, default 12 → a ±2 matchup swings scores by ±24, comparable to
  ~40% of the low-HP term). Also drives loadout counter-picks. Not consulted by
  `combatMath.tradeAdvantage` — a daggers-vs-bow hard counter (+2) doesn't change the
  TTK estimate, only target preference. Acceptable: the matchup is positional, and its
  effects (backstab uptime, kite denial) aren't in the TTK model's vocabulary.

## docs/arena-spec.md — action semantics the code must honor

- `dodge`: 2-tile dash, **3 ticks invuln, 30-tick cooldown** — matches code.
- `shove`: ≤2.0 tiles, knockback 15, 2-tick stun, **1.5s cooldown** — the cooldown is
  NOT tracked anywhere client-side; three call sites can re-issue shove every tick.
- `grapple`: universal, 2 charges/round, **4s cooldown** — `grapple_cooldown` is
  server-echoed on self, and every call site checks it. OK.
- `use_gravity_well`: **needs a gravity_well pickup charge** (collected, not merely
  nearby) — the code's gate checks for a gravity pickup *entity visible on the ground*,
  which is the wrong condition in both directions.
- `place_mine`: max 3/round, arms after 1s, invisible to enemies — matched (controller
  caps at 3, mine cooldown policy-gated).
- `attack`: "must be in weapon range"; range semantics (euclidean vs chebyshev) are not
  spelled out — the engine uses euclidean + 0.5 slack; diagonal-adjacent melee (d≈1.414
  vs range 1) is in the ambiguous band. Flagged for live instrumentation via
  `last_action_result`, not fixable from the spec text alone.
- `bow charged=true` spends a stored charge; charge accrual is server-side
  (`bow_charge_ticks/level` observed, `charged_shot_ready` when spendable) — no client
  windup state machine exists, consistent with pass 1's "inconclusive" on interrupts.
