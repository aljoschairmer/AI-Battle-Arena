# Engine audit, second pass — Phase 1: behavior-by-behavior trace

Format per module: Decision point | Current logic | Inputs used | Inputs available but
unused | Suspected failure mode. The audit brief's known-failure checklist is answered
inline; items the first pass already fixed/ruled out are re-verified briefly, not
re-litigated. New findings carry IDs (C1…, S1…, T1…, M1…) used by Phase 3.

## targeting.ts

| Decision point | Current logic | Inputs used | Available but unused | Suspected failure mode |
|---|---|---|---|---|
| Forced target honor (`selectTarget`, targeting.ts:28-38) | Brain's `primaryTargetId` accepted unless score ≤ -10 | directive, scoreEnemy | — | none new; sane |
| Score fallback + hysteresis (targeting.ts:40-74) | best-scored wins; keep current unless challenger beats it by `targetSwitchHysteresis` (default 30) | scored map, `gs.currentTargetId()` | — | **verified fixed** (pass 1 #2); hysteresis only skipped for forced targets, intended |
| `scoreEnemy` trade term (targeting.ts:128) | `+ tradeAdvantage(ctx, e) * 30` | combatMath | — | **T1: the ×30 weight is the only trade/targeting weight hardcoded instead of an `EnginePolicy` knob** — same class of oversight as pass 1's `0.6` gate (tuning gap, not logic bug) |
| Matchup term (targeting.ts:104) | `matchupRating × targetMatchupWeight` | matchups.ts, enemy weapon | — | verified fixed (pass 1 #5) |
| Trade advantage in selection | present (above) + engage bail in controller | combatMath | — | ruled out (checklist item 1) |
| Velocity leading | in movement (`predictEnemyPos`) + staff `attackAt`; other weapons' attack schema has no aim position | enemyVel | — | ruled out (checklist item 3, same as pass 1) |
| Fog drop (targeting.ts:19) | only `gs.enemies()` (current-tick entities) | — | — | ruled out (checklist item 4); stale positions only reach the no-enemy search path |

## combat.ts

| Decision point | Current logic | Inputs used | Available but unused | Suspected failure mode |
|---|---|---|---|---|
| Gravity-well gate (`tryGravityWell`, combat.ts:158-175) | fires `use_gravity_well` when **a gravity pickup entity is visible on the ground** + 2 clustered enemies | `gs.entities` pickup scan, `enemyCluster` | spec: charge comes from a **collected** pickup; nothing tracks collected charges | **C1 (new, severe): wrong in both directions.** (a) Visible-but-uncollected pickup ⇒ we issue `use_gravity_well` with no charge ⇒ server rejects ⇒ and because `gravityWellBehavior` is priority 6 (above engage), the same conditions hold next tick ⇒ the bot stalls emitting rejected actions for as long as the cluster + pickup persist, doing literally nothing else. (b) After actually collecting the pickup the entity disappears ⇒ gate is false ⇒ **a real charge can never be spent**. Both directions were invisible to pass 1's sim (never spawns pickups; `gravity_well` claimed 0%). |
| Shove sites (combat.ts:40-43, 85-92; survival.ts `createSeparation`:377) | shove issued whenever adjacent + situational trigger | target id, distance | **spec's 1.5s shove cooldown — untracked**; `self.last_action_result` never read | **C2 (new): shove spam.** While our weapon cools next to a target with `posture === "aggressive"` (or `near_impact_surface`), the cooling branch returns `shove` every tick for the whole cooldown window (~5-16 ticks). Only the first can succeed; the rest are rejected server-side and the bot stands still point-blank instead of taking the threat-aware step-away two lines below (combat.ts:98). Same at the spear-brace shove and the cornered `createSeparation` shove (a rejected shove there = standing still in a confirmed-bad trade). Pass 1's sim modeled shove with **no cooldown**, so this class was structurally invisible — worse, the sim *rewarded* the spam (a 2-tick stun landed every tick). |
| Spear vs braced enemy (combat.ts:38-44) | don't attack a braced target; shove if adjacent & weapon cooling; else return null | `brace_ready` | — | **C3 (new): the null is not "wait" — it falls through to `positionForCombat`, which for melee does `moveTo(lead)` (movement.ts:35), i.e. walks INTO the braced enemy.** The docstring's "wait for their brace to expire" is not implemented; the movement layer actively undoes it. Combined with C2 the adjacent case spams shove too. |
| Dagger flank deferral (combat.ts:73-78) | if flank tile is 1 step away, defer to movement | `flankingPosition` | — | verified fixed (pass 1 #3) — but inherits M1's wrong flank tile (below) |
| Bow charged shot (combat.ts:49) | fire charged whenever `charged_shot_ready` && `bowAlwaysCharge` | self charge state | — | checklist "windup/commit": no client-side windup exists to mismanage (pass 1: inconclusive, unchanged) |
| Shield / staff / spear specials | disrupted-bash, AoE-at-cluster-or-lead, brace-wait toggles | per-weapon fields | — | ruled out (checklist item 2): genuinely per-weapon, not one generic path |
| Cooldown step-away (combat.ts:98) | threat-field `safestStep` | ThreatField | — | verified fixed (pass 1 fix 2) |
| Defense/shield timing (checklist item 3) | dodge triggers include `charged_shot_ready`, high `bow_charge_level`, melee pressure — anticipatory, not only post-damage | combat_reads | enemy `facing` (windup direction) | ruled out as "purely reactive"; remaining gap is marginal |
| Mine placement (controller.ts:298-322) | reactive, bearing-aware, retreat-only | retreat vector, chaser bearing | — | proactive zoning still absent — carried Tier-3 item, low priority (unchanged) |

## survival.ts

| Decision point | Current logic | Inputs used | Available but unused | Suspected failure mode |
|---|---|---|---|---|
| Zone return (survival.ts:52-56) | threat-field `safestStep`, fallback `moveTo(zone_center)` | ThreatField | — | verified fixed (pass 1 fix 1); checklist item "straight line" ruled out |
| Imminent-hit dodge exception (survival.ts:40-43) | charged shot preempts environmental survival | shared trigger helper | — | verified fixed (pass 1) |
| Zone-edge drift (survival.ts:73-82) | graduated hard/soft margin, soft band defers to an acceptable fight | trade math, policy margins | — | verified fixed (followup commit 8e25f59) |
| Retreat trigger (survival.ts:293-299) | `hpRetreatFraction − tradeAdvantage × retreatTradeSensitivity` | combatMath | — | verified fixed (pass 1 fix 1); checklist "static threshold" ruled out |
| **Retreat action for ranged weapons (survival.ts:315-334)** | always a move (health pack / field step / blended step) | ThreatField, pickups | **own `weapon_ready` + `effectiveAttackRange` — a bow/staff/spear retreating never fires even with the chaser inside range and the weapon ready** | **S1 (new): no fire-while-kiting.** Retreat claims the tick above engage, so once triggered, a ranged bot flees without ever shooting back — even at a 5-HP melee chaser it outranges by 6 tiles. Pass 1 measured retreat consuming 42% of losing rounds' ticks *with a sword* (nothing to fire at range anyway); for ranged loadouts every one of those ticks also forfeits free damage that would end the chase. Never observed empirically because the sim only ever ran sword. |
| Emergency dodge candidate set (survival.ts:221) | {perp, −perp, away} ranked by threat field | ThreatField | full 8-direction scan (telemetry-only) | carried Tier-3 item; pass 1 telemetry: 0/18 dodges hit — leave unless new data disagrees |
| Dodge checklist item ("away from nearest enemy" anti-pattern) | threat-field-ranked landing | — | — | ruled out again (code, not just README) |
| `createSeparation` (survival.ts:367-385) | cornered ⇒ shove adjacent threat / grapple away | shove, grapple | shove cooldown (see C2) | defensive path exists (pass 1 fix); **C2 applies**: rejected shove = stand still in a losing trade |
| Grapple/shove defensive (checklist) | grapple-away + shove implemented | — | — | ruled out as "missing"; only the C2 economy bug remains |

## movement.ts

| Decision point | Current logic | Inputs used | Available but unused | Suspected failure mode |
|---|---|---|---|---|
| `flankingPosition` (movement.ts:324-335) | "behind" computed from **our approach direction** (perpendicular side-step around the target) | our pos, target pos | **`target.facing` — the field that actually defines "behind"/`rear_exposed`** | **M1 (new): the docstring says "'Behind' = opposite direction of the target's facing" but the code never reads facing.** If the target faces the tile the heuristic picks (e.g. we approach from the east, it faces north, heuristic sends us north), daggers walk into its front arc, never gain `rear_exposed`, and the pass-1 deferral fix faithfully steers to the wrong tile. Backstab is the entire daggers value proposition (+2 vs bow/staff). |
| Melee approach (movement.ts:35) | `moveTo(lead)` — server A*, threat-blind | predictEnemyPos | ThreatField | intentional for committed engagements (trade math + avoid list gate the commitment); unchanged from pass 1 — not re-flagged |
| Kite distance (movement.ts:38-48) | per-weapon `preferredRange` ± `kiteRangeBias`, capped at real range | weapons.ts, policy | — | ruled out (checklist: not a constant) |
| Engage vs hold-ground oscillation | structurally exclusive (cascade) | — | — | ruled out (checklist item 3, unchanged) |
| Pickup safety (movement.ts:108-125, 202-226) | value/detour budget + `enemyControls` + stale-enemy window + hazard-adjacency | lastSeen memory, policy | threat gradient | carried Tier-3; discrete checks now cover the practical cases — low priority |
| `patrolPoint` / `followHint` / `searchLastSeenEnemy` | rotating patrol, server hints, sprint to last-seen | hints, memory | — | none new |

## Checklist verdicts (brief's known patterns)

- Targeting: trade math **in** selection ✓ (weight ×30 hardcoded → T1); debounce ✓ fixed;
  leading ✓ where the schema allows; fog-stale chase ✗ ruled out.
- Combat: charged-attack windup — no client windup exists (unchanged); weapon-specific
  tactics ✓ genuinely per-weapon; defense timing anticipatory ✓; mines reactive-only
  (carried, minor). **New: C1 gravity-well gate inverted, C2 shove-cooldown spam, C3
  spear brace undone by movement.**
- Survival: retreat threshold trade-scaled ✓ fixed; zone path threat-aware ✓ fixed; dodge
  threat-field-ranked ✓ (README claim true in code); grapple/shove defensive ✓ exists
  (economy bug C2). **New: S1 ranged retreat never fires.**
- Movement: pathfinding detour — intentional at commit time; kiting per-weapon ✓;
  oscillation ✗ ruled out. **New: M1 flank geometry ignores `facing`.**
