# Pass 3 addendum — production fleet observation (3 bots + LLM brains, live arena)

Prod env supplied mid-pass: 3 API keys (NeuralReaper, HexMind, GhostProtocol),
OpenRouter key (full 5-agent brains active for the first time), BOT_COOP=true.
~150 bot-rounds observed live with full telemetry. Everything below was found
BY the observation and fixed the same session, each with smoke coverage.

## The friendly-fire saga (7 defensive layers, each forced by a live incident)

Coalition bots kept killing each other. Every mechanism was invisible until
the previous one was fixed:

| # | incident | mechanism | fix |
|---|---|---|---|
| 1 | 23:27 kill (targeting) | friendlyIds had an 8s TTL, but coop reports are tick-driven and ticks stop between rounds/reconnects → friendly sets emptied while teammates lived | membership permanent per process lifetime; member ids can't poison the shared focus pool (incl. self) |
| 2 | 23:55, 00:04 kills | mines are server-invisible to non-owners INCLUDING allies → teammates walked into each other's minefields | own-mine tracking + coalition broadcast (CoopMessage.mines); ally tiles ride hazardTiles() (hard-block isSafeStep) |
| 3 | (cold-start window) | ticks don't flow in the lobby → fresh fleets fought round 1's opening with empty friendly sets | coalition hello broadcast at `connected` |
| 4 | 00:59–01:21 kills, all weapon=sword | sword CLEAVE hits adjacent bots — a legal swing clips the teammate in the arc; targeting can't stop server-side splash | friendlySplashGuard: no swing with ally in arc (≤1.5 of us / ≤1 of target); staff AoE re-aims off ally tiles |
| 5 | 01:27, 01:29 kills post-guard | decision-time guards lose simultaneous-movement races (ally 2 tiles out at decide, adjacent at resolve) | ally repulsion in the threat field (+15 ≤1, +5 at 2): the pack spaces itself so splash can't form |
| 6 | 01:53 kill by a bow slot | arrow through an ally in the fire lane | ranged non-AoE shots hold when an ally is within 0.8 of the firing segment (combat + fire-while-kiting) |
| 7 | (same window) | fresh mine in a shared retreat corridor — broadcasts are tick-batched, <500ms-old mines invisible to allies | no mine seeded while an ally is within 6 tiles |

**Result: 0 teammate kills in the 30 rounds after the full stack deployed**
(vs ~1 per 12 rounds before).

## Fleet draft diversity + learnings (user request)

Three bots drafting from identical inputs converged on all-daggers every
round. Fixes: fleet_index/fleet_size ride the LoadoutRequest; the Loadout
prompt binds archetypes by index (0 free, 1 ranged, 2 frontline) with a
learnings escape hatch; `our_weapon_history` (per-weapon win/played from
RoundHistory — tracked but never fed to the draft) overrides tier-list
defaults both ways; the deterministic fallback rotates fleet indices over the
top-3 ranked picks. First advisory wording failed live (daggers/sword/daggers)
→ rule made binding → drafts landed daggers/staff/sword.

**Measured at 150 rounds: bow 8 wins/27 rounds (30%) vs daggers 2/69, sword
1/50 — 8 of the fleet's 11 wins come from the ranged slot the diversity rule
forced into existence.**

## Engine deep dive (evidence-first)

Telemetry over 115k ticks: bots spend 72% of ticks dead (one elimination ends
their round) and 44% of alive time retreating at genuinely low HP → survival
features dominate expected impact. Trade discipline (1% negative-advantage
engagements), dodge accuracy (12% hit-anyway) and hysteresis all healthy.

Shipped: **hazard pulse awareness** (wire carries `active:false`; dormant
pulse hazards were permanently lethal to the model — now crossable with a
+12 residual) and **zone-escape grapple** (stranded outside = walking only at
3 HP/tick; now anchor-pulls up to 12 tiles toward the zone; knobs
`grappleZoneEscape`/`grappleZoneEscapeMinDist`).

Rejected with reasons: teleport pads (wire never carries pad state),
self-brace (no such client action), reconnect-to-redraft (lobby cost/gaming),
sudden-death posture (speculative — the endgame posture failed live A/B
0-for-18), capture-pad combat weighting + last_action_result + regroup
consumer (real but low-leverage; regroup is dead code today).

## Other prod-observation fixes

- `BOT_NAMES` csv support (was silently ignored; fleet fought as
  NeuralReaper-1/2/3).
- Per-bot telemetry channels (singleton sink kept only the last-connected
  bot's file per round — blocked the first friendly-fire investigation).
- Death-frame weapon enrichment records unknown as `""` instead of guessing
  "sword" (the guess misdirected a root-cause hunt for a full cycle).
- Learning loop verified end-to-end live: outcomes → Analyst insights naming
  the real killers → Tuner policy patches applied by engines mid-session →
  disk persistence restoring the opponent book across every restart →
  next drafts counter-picking from it.

## Status at close of observation

149 bot-rounds, 11 wins, 145 kills / 136 deaths (K/D > 1), ELO ~162 and
stable. Top opposing predators: Hook, Archmage, Reaper, Valkyrie, Fortress.
