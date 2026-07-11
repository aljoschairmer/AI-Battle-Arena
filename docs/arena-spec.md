# Arena reference (deep dive)

Canonical facts pulled from the live site so the bot's assumptions are grounded
in the real server, not guesses. Sources:

- **`GET /api/v1/bot-setup`** — the authoritative machine-readable spec (actions,
  game mechanics, stat formulas, weapons, protocol). This is the source of truth.
- **`GET /api/v1/weapon-stats`** — live, dynamically-balanced weapon numbers.
- The dashboard's **Strategy** and **Skills** tabs (`/dashboard/?view=public`,
  loaded into the site's "toolkit" overlay), which render the above plus a static
  weapon-matchup matrix.

## Stat formulas (Skills/Simulator tabs) — confirmed

The server's `stats.formulas` match [`src/shared/derived.ts`](../src/shared/derived.ts) **exactly**:

| Stat | Formula |
| --- | --- |
| Max HP | `100 + hp*10` (5 → 150) |
| Move speed | `3.0 + speed*0.5` (5 → 5.5) |
| Attack mult | `1.0 + attack*0.1` (5 → 1.5×) |
| Defense reduction | `defense*0.03` (5 → 15%), capped 30% |
| Damage | `weapon_damage * attack_mult * (1 - target_defense_reduction)` |

Budget 20, each stat 1–10. Default allocation 5/5/5/5. `stats.fallback_behaviors`
in the spec lists **`aggressive · defensive · opportunistic`**, but the published
list is incomplete: the server VALIDATES this field (an invalid value returns
`error: invalid fallback "…", using default "defensive"`) and it accepts
**`territorial` and `hunter`** without complaint (verified live 2026-07-02,
pass-4 audit) — all five values in our `FallbackBehavior` type are legal.

## Skills tab — actions & universal abilities

| Action | Notes (from `bot-setup.actions`) |
| --- | --- |
| `move` / `move_to` | direct vector vs. server A* pathfind to a tile |
| `attack` | must be in weapon range. Bow: `charged=true` spends stored charge. Staff: `target_position` places a delayed AoE |
| `dodge` | dash with **3 ticks invuln**, **30-tick** cooldown (speed ×2) |
| `shove` | push a bot within **2.0 tiles**, knockback 15, **2-tick stun**, 1.5s cooldown |
| `place_mine` | plant at current pos, **max 3 per bot**, arms after 1s, invisible to enemies |
| `use_gravity_well` | deploy at a tile (needs a `gravity_well` pickup charge); pulls enemies 3s |
| `grapple` | **universal**, 2 charges/round, **4s cooldown**, ≤12 tiles: yank an enemy (15 dmg, 3-tick stun) **or** anchor-pull yourself to a tile |
| `use_item` | pick up an item within collect radius (2 tiles) |

### Arena systems (Skills tab "new_features")

- **capture_pad** — stand uncontested 20 ticks → +12 score, 20 shield, 1.2× dmg (80t); owner control-pulse every 15t (+2 score, 4 shield). Tick entities (`type:"capture_pad"`) and `/arena/map` expose the full state machine: `progress_ticks/capture_ticks/owner_id/capturing_bot_id/is_contested/contender_count/is_ready/cooldown_remaining_ticks/next_control_pulse_ticks/radius`.
- **bounty_system** — consecutive winners build a public bounty; board at `GET /api/v1/bounties`. **Live beacon (pass-4):** every tick carries `tick.bounty_target` (bot_id) plus a fog-exempt `nearby_entities` entry `{type:"bounty_target", bot_id, name, position}` with the carrier's LIVE position, and `your_state.is_bounty_target` flags when the carrier is us. The REST board can be empty while a beacon is active — the beacon is authoritative.
- **environmental_hazards** — 6 pulsing damage RECTANGLES, wire type **`hazard_zone`** (not "hazard"): top-left `position` + `width`×`height`, `active/on_ticks/off_ticks/tick_counter/damage_per_tick`; worse during `hazard_storm`. Full static layout in `/arena/map.hazard_zones`.
- **teleport_pads** — 3 linked pairs (`linked_pad_id`); `is_ready`/`cooldown_remaining_ticks`; re-arm fast during `teleport_surge`. Full layout in `/arena/map.teleport_pads`.
- **sudden_death** — at min zone radius, random tiles become void (instant death). Keep moving. Ticks expose it as `tick.sudden_death: bool`.
- **combat_reads** — ticks expose `brace_ready`, `bow_charge_ticks/level`, `charged_shot_ready`, `recently_disrupted_ticks`, `rear_exposed`, `near_impact_surface`, and each visible bot's live **`target_id`** (who it's locked onto).
- **special_round_modifiers** — `fast_zone`, `pickup_surge`, `double_bounty`, `teleport_surge`, `hazard_storm` (exposed as `round_modifier` in round_start AND echoed on every tick).
- **self echoes (pass-4)** — `your_state` also carries `gravity_well_charge`, `mine_count`, `relay_battery_active/_ticks` — no client-side bookkeeping needed for these.
- **spectator feed** — `WS /ws/spectator` (public, no auth) broadcasts one `arena_state` frame per tick with the FULL global state: all bots (position/hp/target_id), all landmines (position/owner/armed — invisible in bot fog), pickups, pads, hazards, kill feed, sudden_death.

### Pickups (11 types)

health_pack (+30 HP) · speed_boost (2× 50t) · damage_boost (1.5× 50t) ·
shield_bubble (absorb 50) · gravity_well (1 charge) · cooldown_shard (60%
cooldowns 100t) · bounty_token (+18 next kill 90t) · hazard_key (hazard immunity
+2× pad capture 80t) · overdrive_core (1.25× dmg + 75% cooldowns 60t) ·
grapple_charge (+1 grapple, clears cd) · relay_battery (+1 capture progress/tick 90t).

## Strategy tab — weapon matchup matrix

`[attacker][defender]`, −2 (hard counter) … +2 (hard advantage). Encoded in
[`src/engine/matchups.ts`](../src/engine/matchups.ts) and used for counter-picks.

| atk＼def | sword | bow | daggers | shield | spear | staff |
| --- | --- | --- | --- | --- | --- | --- |
| **sword** | 0 | −1 | +1 | +1 | 0 | −1 |
| **bow** | +1 | 0 | **−2** | +1 | +1 | 0 |
| **daggers** | −1 | **+2** | 0 | −1 | −1 | **+2** |
| **shield** | −1 | −1 | +1 | 0 | −1 | **−2** |
| **spear** | 0 | −1 | +1 | +1 | 0 | −1 |
| **staff** | +1 | 0 | **−2** | **+2** | +1 | 0 |

Key reads: **daggers hard-counter bow & staff** (close the gap before they fire),
**staff hard-counters shield** (AoE ignores the block), **bow kites melee** but
dies to daggers. Grapple isn't rated (universal ability) → treated as even.

### Weapon roles (Strategy tab)

| Weapon | Role | Strong vs | Countered by |
| --- | --- | --- | --- |
| Sword | Balanced frontline (cleave) | Daggers, shield | Bow, staff |
| Bow | Long-range poke + charge | Shield, spear | Daggers, grapple |
| Daggers | Close-range burst assassin | Bow, staff | Sword, spear |
| Shield | Slow attrition tank (50% block) | Daggers | Staff, bow |
| Spear | Spacing + brace control (knockback) | Daggers, shield | Bow, staff |
| Staff | Delayed AoE zone denial (burn field) | Shield, sword | Daggers, bow |
| Grapple | Wall-slam bruiser | Cornered ranged bots | Bow, staff |

The site's suggested *starter* splits are close to 5/5/5/5; we instead run
fight-power-optimal builds (see [`derived.ts`](../src/shared/derived.ts) — HP+attack
heavy, low defense) which beat the neutral split by ~9%.

---

## Game modes, service status & sudden-death additions (guide sync 2026-07-11)

Synced against BOT-GUIDE.md (github.com/ablac/Arena) + live `GET /api/v1/bot-setup`.

### Game modes (`game_mode` on every tick)

| Mode | Win condition | Our handling |
| --- | --- | --- |
| `ffa` | Last bot alive | Unchanged (default) |
| `team_battle` | Last team with a living bot | `your_state.team`/entity `team` parsed; same-team bots are allies (never targeted, splash/fire-lane guards apply) |
| `ctf` | First team to 3 flag captures | Flag logic: return own dropped flag, steal enemy flag, deliver carried flag home (`ctf_objective` priority rung) |

- Teams re-roll each round; friendly fire is off (attacks on teammates deal 0 —
  pure wasted actions). `team_scores` and `flags` only present in team modes.
- **Flags/base positions are WORLD coordinates** (÷ `cell_size` = 20 for grid) —
  the only world-unit fields in bot tick messages. Flags are never fog-limited.
- CTF rounds do NOT end by elimination — dead teams' flags remain stealable.

### Sudden death (extended)

- `tick.void_tiles` — instant-death tiles inside our fog, **accumulated**
  per round in `GameState` (impassable + hazard-haloed).
- `tick.sudden_death_stall` — nobody dealt damage for the stall window (20s):
  EVERYONE takes ramping damage until combat resumes. Engine forces
  aggression=1 / no HP-retreat while active.

### `service_status` (WS frame + `connected`/`tick` snapshot + REST)

- Whitelisted as a server frame; revision-guarded (ignore lower revisions).
- `maintenance.retry_after_seconds` = MINIMUM reconnect delay (transport floor
  in `ws.ts`); planned restarts close with WS code **1012** (logged as such).
- REST twin: `GET /api/v1/service-status` (`rest.getServiceStatus`).

### Spectator feed additions

- App-level `heartbeat` (~10s, also while paused) — connection health only,
  no gameplay state; deliberately does not refresh frame freshness.
- **Keyframe rule:** `obstacles` only arrives on every 10th broadcast — the
  feed carries the last copy forward instead of clearing between keyframes.
- Bot entries carry `team`; frames carry `game_mode`/`team_scores`/`flags`.

### Cosmetics (presentation-only, no gameplay effect)

`GET /api/v1/cosmetics/catalog` (public), `GET/PUT /api/v1/bot/cosmetics`
(auth) — implemented in `rest.ts` (`getCosmeticsCatalog`, `getBotCosmetics`,
`putBotCosmetics`). Not called anywhere by default.
