# Fight summary — all recorded rounds

**629 bot-rounds** logged from 07-02 00:08 to 07-04 11:54 UTC: **69 wins,
684 kills / 551 deaths** (K/D 1.24). Source: `logs/outcomes/outcomes.jsonl`
(re-generate anytime with `npx tsx scripts/analyze-outcomes.ts`).

## By experiment variant

| variant | rounds | wins | win% | kills/deaths | what it was |
|---|---|---|---|---|---|
| baseline | 11 | 2 | 18% | 13/10 | pre-pass-3 code, solo deterministic bot |
| pass3 | 11 | 0 | 0% | 5/11 | all pass-3 features on, proxy-storm window |
| control | 11 | 3 | 27% | 8/10 | new build, new knobs off |
| pass3b | 7 | 0 | 0% | 1/7 | all features on, clean infra |
| pass3c | 11 | 4 | 36% | 2/10 | endgame off, rest on → led to the endgame revert |
| **prod-llm** | **578** | **60** | **10%** | **655/503** | 3-bot LLM coalition fleet, evolving all night |

## Production fleet (3 bots, 15-bot FFA lobbies — uniform chance ≈ 7%/bot)

| bot | rounds | wins | win% | kills/deaths |
|---|---|---|---|---|
| GhostProtocol | 192 | 35 | **18%** | 247/149 |
| HexMind | 191 | 17 | 9% | 239/169 |
| NeuralReaper | 192 | 8 | 4% | 168/182 |

| weapon | rounds | wins | win% | kills |
|---|---|---|---|---|
| bow | 150 | 35 | **23%** | 221 |
| grapple | 29 | 4 | 14% | 55 |
| sword | 164 | 13 | 8% | 179 |
| spear | 29 | 2 | 7% | 29 |
| daggers | 203 | 6 | **3%** | 165 |
| staff | 3 | 0 | 0% | 6 |

The bow/daggers split (23% vs 3%) is what drove the fleet-wide weapon-evidence
enforcement: history now overrides tier lists for every draft slot.

**Trend** (per-bot win rate): first 100 prod rounds ~6% → last 100 **13%** →
last 50 **14%**. ELO across the prod run: 119 → **250**. The win list shows
the shift: 1 win in the first 3 hours, then 19 wins in the final 3.5 hours —
sword and grapple slots started converting alongside bow once the coalition
guards, evidence drafting, and hazard-zone awareness (merged from main) were
all live.

## By round modifier (prod)

| modifier | wins/rounds |
|---|---|
| none | 38/386 |
| fast_zone | 9/75 |
| hazard_storm | 5/33 |
| pickup_surge | 5/30 |
| teleport_surge | 2/21 |
| double_bounty | **1/33** — the bloodbath rounds; discipline rules added late in the pass |

## Who beats us

Scorpion (43), Hook (39), Valkyrie (34), Reaper (33), Archmage (33),
Fortress (30), Deadeye (27), Viper (27), Lancer (25), Juggernaut (22).
Grapple-archetype hunters (Hook, Scorpion) topping the list is what motivated
the 12-tile yank-range threat modeling.

**Teammate kills: 51 total** across the night — the friendly-fire saga.
Ten distinct mechanisms were found and closed one by one (membership TTL,
focus-pool poisoning, mines ×3 channels, cleave, movement races, fire lanes,
grapple pulls, server autopilot); the final windows ran clean.

## Biggest single rounds

- NeuralReaper (daggers): 7-kill round win — the fleet's first victory
- GhostProtocol (bow): two 6-kill wins; 35 total round wins, best bot of the fleet
- NeuralReaper (bow, post-evidence-override): 6/5/5-kill win streak within 16 minutes
- HexMind (grapple): four 4-5-kill wins in under an hour
