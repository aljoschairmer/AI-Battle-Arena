# Engine audit, second pass — Phase 2: instrumentation and observations

## What was added (all behavior-neutral, verified by unchanged smoke)

- **`action_issued` telemetry event** at a new single choke point in
  `Controller.decide()` (the cascade body moved to `decideInner`, no priority changes):
  one flat event per tick recording the action type actually sent. This is the signal the
  pass-1 events couldn't see — priority names tell you *engage_target* claimed a tick,
  not whether it produced an attack or the hundredth futile move.
- **Analyzer additions**: action mix per round, shove-cooldown violations (two shoves
  <15 ticks apart = the second is rejected server-side per spec), longest
  consecutive-tick `use_gravity_well` run (stall detector).
- **Sim fidelity fixes** (`scripts/simulate.ts`) closing pass 1's own declared gaps:
  `SIM_WEAPON=` equips our bot with any weapon (was hardcoded sword); `SIM_PICKUPS=1`
  spawns health + gravity_well pickups; shove now enforces the spec's 1.5s cooldown
  (pass 1's sim let shove land every tick, actively rewarding the spam pattern);
  `use_gravity_well` without a collected charge is now a rejected no-op, and `use_item`
  actually collects (health heals, gravity grants a charge).
- **GameState action-economy bookkeeping** (`noteIssuedAction`, `shoveReady`,
  `gravityCharges`) fed from the same choke point — inert until Phase 4 consumers read it.

Runs: `SIM_MATCHES=3 TELEMETRY_LOG=1 TELEMETRY_LOG_DIR=logs/pass2/pre-<cfg> [SIM_WEAPON=…]
[SIM_PICKUPS=1] npx tsx scripts/simulate.ts` — 18 rounds per weapon config (6 policy
configs × 3), same harsh 1v5 scenario as pass 1. Same caveats as pass 1 apply
(mechanism-level evidence, not live win-rate estimates; wall-clock stats meaningless).

## Results

### Daggers are completely non-functional — 0 damage in 18/18 rounds

| Weapon (pre-fix) | best config win% | kills (avg, all configs) | dmgDealt (avg) |
|---|---|---|---|
| sword | 100% (defensive) | 0.33–2.00 | 153–229 |
| bow | 100% (balanced+/defensive) | 0–1.67 | 152–196 |
| staff (+pickups) | 67% (very_aggressive) | 0.33–1.33 | 92–185 |
| **daggers** | **0% (every config)** | **0.00 (every config)** | **0 (every config)** |

Representative round (`current(defaults)_m0`): 185 ticks, 88 claimed by `engage_target`,
44 explicit `engage` trade decisions — and the action mix contains **zero `attack`
actions** (108 move, 64 move_to, 5 grapple, 5 dodge, 3 place_mine).

Mechanism (Phase 1 M1, upgraded): `flankingPosition` ignores `target.facing` and computes
the "flank" tile perpendicular to **our own approach axis**. Arriving at that tile flips
the approach axis, which moves the computed flank tile, which is now exactly 1 step away —
so `combatBehavior`'s pass-1 deferral rule ("one step from the flank tile → let movement
finish") re-arms every tick and the bot **orbits the target indefinitely, never
attacking**. Pass 1's fix #3 turned "daggers never flank" into "daggers never attack";
its smoke test only asserted a single tick's deferral, and its sim only ever ran sword,
so the non-termination across ticks was invisible.

### Ranged retreat never fires — retreat share separates every bow loss from every win

Bow, 18 rounds: every loss spent 17.7%–76.1% of its ticks in `retreat_heal_mine`; every
win spent ~0%. Worst case (`aggressive+dodge_m2`): 298/417 ticks (71.5%) retreating, 8
attacks all round. The retreat rung claims the tick above engage, and `retreatAndHeal`
only ever emits moves — a bow with 8-tile range being chased by melee never fires a shot
it could land for free (Phase 1 S1 confirmed). This reproduces pass 1's headline
"retreat dominance" signature with the added precision that for ranged loadouts every
one of those ticks also forfeits damage the weapon could deliver while kiting.

### Gravity-well gate misfires confirmed; magnitude moderate, not the worst case

Staff + pickups: one round issued 4 `use_gravity_well` with a longest consecutive run of
2 — all rejected in-sim (no collected charge; the engine's gate had merely *seen* a
pickup on the ground). The catastrophic indefinite stall requires a persistent cluster +
visible pickup, which enemy movement breaks up; the observed cost is wasted ticks at
priority 6 (combat preempted). The **other direction is structural, not statistical**:
after actually collecting a gravity pickup the ground entity disappears, the gate goes
false, and a genuinely held charge can never be spent — 100% waste of the item by
construction (Phase 1 C1 confirmed in both directions).

### Shove spam / spear brace — not reachable in this sim, static findings stand

No shove was issued in any sword/dagger round: the triggering conditions
(`posture === "aggressive"` from the live Tactician, `near_impact_surface`,
`brace_ready`) are constants the sim never sets. C2/C3 remain code+spec findings: three
call sites can re-issue shove inside its 1.5s cooldown (rejected → stand still
point-blank), and the spear brace-wait's `return null` hands the tick to
`positionForCombat`, which walks into the braced enemy.

### Incidental

- Sword baseline with pass-1 fixes: defensive/balanced configs now win 67–100% of these
  1v5 sims (pass 1 measured ~6% pre-fix) — the pass-1 fixes demonstrably moved the
  needle; the remaining consistent live losses are concentrated in the weapon-specific
  paths above, consistent with the Brain's loadout agent frequently picking
  daggers/bow (meta tiers) while the engine audit only ever hardened sword play.
- Dodge accuracy: still 0 hit-despite-lowest-danger across all runs (5+ dodges/round) —
  pass 1 Tier-3 #7 stays deprioritized.
- Bad-engage rate: daggers rounds show 10/44 engages with negative predicted advantage
  (avg −0.07) — an artifact of the orbit (the "engagement" never actually traded), not
  new evidence against the engage gate.
