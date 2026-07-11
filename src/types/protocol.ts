/**
 * AI Battle Arena wire protocol.
 *
 * Transcribed from the live protocol reference at arena.angel-serv.com.
 *
 * Coordinate convention: all in-match WebSocket coordinates (tick state, actions,
 * safe zone) are GRID coordinates in [0, 99] as `[col, row]`. The arena is a
 * 100x100 grid of 20-unit cells (2000x2000 world units). Terrain is row-major:
 * look up a grid position `p = [col, row]` as `terrain[row][col]`.
 *
 * REST endpoints (arena/status) report some values (e.g. safe_zone_radius=1000)
 * in WORLD units; do not mix them with in-match grid units.
 */

export type GridVec = [number, number]; // [col, row], 0..99
export type WorldVec = [number, number]; // [x, y], 0..1999

export type Weapon =
  | "sword"
  | "bow"
  | "daggers"
  | "shield"
  | "spear"
  | "staff"
  | "grapple";

/** Active game mode, echoed in every tick. FFA is the classic battle royale;
 * team_battle is last-team-standing; ctf is first-to-3-captures. */
export type GameMode = "ffa" | "team_battle" | "ctf";

/**
 * One team flag in CTF (one entry per team; empty array in team_battle).
 * IMPORTANT: `position` and `base_position` are WORLD coordinates (÷ cell_size
 * for grid tiles) — unlike every other position in bot tick messages. Flags
 * are a global objective and are NOT fog-limited.
 */
export interface FlagState {
  id: string;
  team: number;
  position: WorldVec;
  base_position: WorldVec;
  status: "at_base" | "carried" | "dropped";
  /** bot_id of the carrier when status is "carried", else "". */
  carrier_id: string;
}

// Server-side autonomous behaviour applied when the bot sends no action for a
// tick. These are the exact values the arena accepts in select_loadout.
export type FallbackBehavior =
  | "aggressive"
  | "defensive"
  | "opportunistic"
  | "territorial"
  | "hunter";

export interface StatBlock {
  hp: number;
  speed: number;
  attack: number;
  defense: number;
}

// ---------------------------------------------------------------------------
// Server -> Bot messages
// ---------------------------------------------------------------------------

export interface ConnectedMsg {
  type: "connected";
  bot_id: string;
  arena_size: WorldVec;
  grid_size: GridVec;
  cell_size: number;
  fog_radius: number;
  available_weapons: Weapon[];
  stat_budget: number;
  stat_min: number;
  stat_max: number;
  timeout_seconds: number;
  last_loadout: LoadoutSelection | null;
  /** Snapshot of the current operator broadcast / maintenance state. */
  service_status?: ServiceStatusMsg;
}

/**
 * Operator broadcast / scheduled-maintenance status. Sent as a standalone
 * frame when published/cleared, snapshotted in `connected`, and repeated in
 * `tick.service_status` while maintenance is active. Treat each snapshot as a
 * full replacement; ignore snapshots whose `revision` is lower than the last
 * one processed. When `maintenance` is non-null, honour `retry_after_seconds`
 * as the minimum reconnect delay (planned restarts close with WS code 1012).
 */
export interface ServiceStatusMsg {
  type: "service_status";
  revision: number;
  server_time?: string;
  broadcast: {
    id?: number;
    severity?: string;
    message?: string;
    published_at?: string;
  } | null;
  maintenance: {
    id?: number;
    severity?: string;
    message?: string;
    phase?: string;
    estimated_downtime_seconds?: number;
    retry_after_seconds?: number;
    published_at?: string;
  } | null;
}

export interface LoadoutConfirmedMsg {
  type: "loadout_confirmed";
  weapon: Weapon;
  stats: StatBlock;
  computed: {
    max_hp: number;
    move_speed: number;
    attack_mult: number;
    defense_red: number;
    attack_range: number;
    cooldown_seconds: number;
    weapon_damage: number;
  };
  position: WorldVec;
}

export interface LobbyPlayer {
  name: string;
  avatar_color: string;
  weapon: Weapon;
}

export interface LobbyMsg {
  type: "lobby";
  bots_connected: number;
  bots_needed: number;
  countdown: number | null;
  players: LobbyPlayer[];
}

export interface SafeZone {
  center: GridVec;
  radius: number;
  target_center: GridVec;
  target_radius: number;
}

export interface RoundStartMsg {
  type: "round_start";
  round_number: number;
  round_modifier: string;
  round_modifier_label: string;
  position: GridVec;
  bots_in_round: number;
  all_positions: Record<string, GridVec>;
  safe_zone: SafeZone;
}

export interface Effect {
  name: string;
  ticks: number;
}

export interface ActionResult {
  action: string;
  result: string; // "hit" | "miss" | "blocked" | ...
  target?: string;
  damage?: number;
}

export interface HitReceived {
  attacker_id: string;
  damage: number;
  weapon: Weapon;
}

export interface KillFeedEntry {
  killer: string;
  victim: string;
  weapon: Weapon;
  tick: number;
}

/** The bot's own full state, only present in `tick` messages. */
export interface SelfState {
  bot_id: string;
  /** Team number in team modes (1, 2, ...); 0 in FFA / unassigned. */
  team?: number;
  position: GridVec;
  hp: number;
  max_hp: number;
  speed: number;
  weapon: Weapon;
  cooldown_remaining: number;
  weapon_ready: boolean;
  is_alive: boolean;
  kill_streak: number;
  round_kills: number;
  dodge_cooldown: number;
  invuln_ticks: number;
  stun_ticks: number;
  facing: GridVec;
  recently_disrupted_ticks: number;
  brace_ready: boolean;
  bow_charge_ticks: number;
  bow_charge_level: number;
  charged_shot_ready: boolean;
  hazard_key_active: boolean;
  hazard_key_ticks: number;
  /** relay_battery pickup buff: +1 capture progress/tick while contesting pads. */
  relay_battery_active?: boolean;
  relay_battery_ticks?: number;
  bounty_token_bonus: number;
  shield_absorb: number;
  /**
   * Server-echoed gravity-well charge count (verified live 2026-07-02) —
   * authoritative over any locally-tracked optimistic count.
   */
  gravity_well_charge?: number;
  /** Server-echoed count of mines we've placed this round (max 3). */
  mine_count?: number;
  /** True when WE carry the arena bounty — everyone sees our live position. */
  is_bounty_target?: boolean;
  effects: Effect[];
  last_action_result: ActionResult | null;
  hits_received: HitReceived[];
  kill_feed: KillFeedEntry[];
  in_safe_zone: boolean;
  distance_to_zone_edge: number;
  zone_radius: number;
  zone_center: GridVec;
  zone_target_center: GridVec;
  zone_target_radius: number;
  grapple_charges: number;
  grapple_cooldown: number;
}

export interface NearbyBot {
  type: "bot";
  bot_id: string;
  name: string;
  /** Team number in team modes; 0 in FFA. Same-team bots are allies — never
   * attack them (friendly fire is off by default: the hit deals no damage). */
  team?: number;
  position: GridVec;
  hp: number;
  max_hp: number;
  weapon: Weapon;
  is_alive: boolean;
  avatar_color: string;
  last_action: string;
  is_dodging: boolean;
  is_stunned: boolean;
  facing: GridVec;
  recently_disrupted_ticks: number;
  brace_ready: boolean;
  bow_charge_ticks?: number;
  bow_charge_level: number;
  charged_shot_ready: boolean;
  rear_exposed: boolean;
  near_impact_surface: boolean;
  has_los: boolean;
  attack_range: number;
  can_attack: boolean;
  threat_score: number;
  /** bot_id this enemy is currently locked onto ("" when none) — who's fighting whom. */
  target_id?: string;
}

export interface NearbyPickup {
  type: "pickup";
  pickup_id: string;
  pickup_type: string;
  position: GridVec;
}

export interface NearbyBurnField {
  type: "burn_field";
  id: string;
  position: GridVec;
  radius: number;
  ticks_left: number;
  active: boolean;
  owner_id?: string;
}

/**
 * A pulsing environmental damage rectangle. `position` is the top-left tile of
 * a `width`×`height` rect; `active` toggles on a `on_ticks`/`off_ticks` cycle
 * tracked by `tick_counter`. Sent both as tick entities (in fog) and in
 * GET /api/v1/arena/map (`hazard_zones`, full static layout, pre-round).
 * Live wire type is "hazard_zone" — NOT "hazard" (verified 2026-07-02).
 */
export interface HazardZoneState {
  id: string;
  position: GridVec;
  width: number;
  height: number;
  active: boolean;
  on_ticks: number;
  off_ticks: number;
  tick_counter: number;
  damage_per_tick: number;
}

export interface NearbyHazardZone extends HazardZoneState {
  type: "hazard_zone";
}

/**
 * Neutral objective pad: stand uncontested `capture_ticks` to own it. The full
 * live state machine — also in /arena/map (`capture_pads`) and spectator frames.
 */
export interface CapturePadState {
  id: string;
  position: GridVec;
  radius: number;
  progress_ticks: number;
  capture_ticks: number;
  owner_id: string;
  capturing_bot_id?: string;
  is_contested: boolean;
  contender_count: number;
  is_ready: boolean;
  cooldown_remaining_ticks: number;
  next_control_pulse_ticks: number;
}

export interface NearbyCapturePad extends CapturePadState {
  type: "capture_pad";
}

/** One end of a linked teleporter pair (3 pairs per round). */
export interface TeleportPadState {
  id: string;
  position: GridVec;
  is_ready: boolean;
  cooldown_remaining_ticks: number;
  linked_pad_id: string;
  color?: string;
}

export interface NearbyTeleportPad extends TeleportPadState {
  type: "teleport_pad";
}

/**
 * Global bounty beacon: present in EVERY tick's nearby_entities whenever a
 * bounty target exists, with the target's LIVE position — even far outside our
 * fog radius (verified live: target at [88,31] delivered while we stood at
 * [11,68]). The REST bounty board can be empty while this is active; treat the
 * beacon as authoritative.
 */
export interface NearbyBountyTarget {
  type: "bounty_target";
  bot_id: string;
  id?: string;
  name: string;
  position: GridVec;
}

export interface NearbyHazard {
  // Note: no broad `string` here — that would break discriminated-union narrowing
  // on `entity.type` for the bot/pickup/burn_field branches.
  type: "hazard" | "gravity_well" | "mine" | "void";
  id?: string;
  position: GridVec;
  radius?: number;
  ticks_left?: number;
  active?: boolean;
}

export type NearbyEntity =
  | NearbyBot
  | NearbyPickup
  | NearbyBurnField
  | NearbyHazardZone
  | NearbyCapturePad
  | NearbyTeleportPad
  | NearbyBountyTarget
  | NearbyHazard;

/**
 * Navigation hint the server sends in `tick.hints` when no enemy is inside the
 * fog. Points toward the nearest ~3 bots and the nearest pickup of each type.
 * `direction` is a normalized [x, y] vector (col, row axes); `distance` is in
 * world units (≈ tiles × cell_size).
 */
export interface NavHint {
  hint_type: "bot" | "pickup";
  direction: [number, number];
  distance: number;
  pickup_type?: string;
}

export interface TickMsg {
  type: "tick";
  tick: number;
  tick_number: number;
  /** Round-relative tick (1 at round start). */
  round_tick?: number;
  /** Live round modifier, echoed every tick (also in round_start) — lets a
   * mid-round (re)connect learn the modifier without waiting a round. */
  round_modifier?: string;
  /** True once random tiles start becoming instant-death void (min zone radius). */
  sudden_death?: boolean;
  /** True while the sudden-death stall punisher runs: nobody has dealt damage
   * for the stall window and EVERY living bot takes ramping environmental
   * damage until combat resumes. Passivity is lethal — go fight. */
  sudden_death_stall?: boolean;
  /** Instant-death void tiles within our fog radius (only present during
   * sudden death). [col, row] grid coords. */
  void_tiles?: GridVec[];
  /** Active game mode — always present on live ticks; optional here so replays
   * of older captured frames stay parseable. */
  game_mode?: GameMode;
  /** Team modes only: string-keyed team number -> score (CTF: flag captures). */
  team_scores?: Record<string, number>;
  /** CTF only: every team flag, global (not fog-limited), WORLD coordinates. */
  flags?: FlagState[];
  /** Repeated maintenance/broadcast snapshot while one is active. */
  service_status?: ServiceStatusMsg;
  /** bot_id of the current bounty target, or "" — see NearbyBountyTarget. */
  bounty_target?: string;
  fog_radius: number;
  your_state: SelfState;
  nearby_mines: number;
  nearby_entities: NearbyEntity[];
  safe_zone: SafeZone;
  /** Present only when no enemy is visible in the fog. */
  hints?: NavHint[];
}

export interface KillMsg {
  type: "kill";
  victim_name: string;
  victim_id: string;
  weapon_used: Weapon;
  your_kill_streak: number;
  your_round_kills: number;
}

export interface DeathMsg {
  type: "death";
  killed_by: string;
  killer_name: string;
  weapon_used: Weapon;
  damage: number;
  your_kills_this_life: number;
  respawn: boolean;
}

export interface RespawnMsg {
  type: "respawn";
  position: WorldVec;
  hp: number;
}

export interface RoundEndMsg {
  type: "round_end";
  round_number: number;
  your_stats: { kills: number; deaths: number; damage: number };
  round_winner: string;
  next_round_in: number;
}

export interface ErrorMsg {
  type: "error";
  message: string;
  code?: string;
  details?: string;
}

export interface KickMsg {
  type: "kick";
  reason: string;
}

export type ServerMessage =
  | ConnectedMsg
  | LoadoutConfirmedMsg
  | LobbyMsg
  | RoundStartMsg
  | TickMsg
  | KillMsg
  | DeathMsg
  | RespawnMsg
  | RoundEndMsg
  | ErrorMsg
  | KickMsg
  | ServiceStatusMsg;

// ---------------------------------------------------------------------------
// Bot -> Server messages
// ---------------------------------------------------------------------------

/**
 * Direct-message authentication: connect without a key and send this as the
 * first frame. The `?key=` query-param path was broken server-side for a while
 * (upgrade returned HTTP 200 instead of 101) but works again as of 2026-07-02;
 * both paths are now valid (ARENA_WS_AUTH selects one, message remains the
 * default since it survived the outage).
 */
export interface AuthMsg {
  type: "auth";
  api_key: string;
}

export interface LoadoutSelection {
  weapon: Weapon;
  stats: StatBlock;
  fallback_behavior: FallbackBehavior;
}

export interface SelectLoadoutMsg extends LoadoutSelection {
  type: "select_loadout";
}

export type ActionType =
  | "move"
  | "move_to"
  | "attack"
  | "dodge"
  | "shove"
  | "place_mine"
  | "grapple"
  | "use_gravity_well"
  | "use_item"
  | "idle";

export interface BaseAction {
  type: "action";
  tick: number;
  action: ActionType;
}

export interface MoveAction extends BaseAction {
  action: "move";
  direction: GridVec;
}
export interface MoveToAction extends BaseAction {
  action: "move_to";
  target_position: GridVec;
}
export interface AttackAction extends BaseAction {
  action: "attack";
  target: string;
  /** Bow only: spend a charged shot. */
  charged?: boolean;
  /** Staff only: place the delayed AoE/burn field at this grid tile. */
  target_position?: GridVec;
}
export interface DodgeAction extends BaseAction {
  action: "dodge";
  direction: GridVec;
}
export interface ShoveAction extends BaseAction {
  action: "shove";
  target: string;
}
export interface PlaceMineAction extends BaseAction {
  action: "place_mine";
}
export interface GrappleAction extends BaseAction {
  action: "grapple";
  target?: string;
  target_position?: GridVec;
}
export interface GravityWellAction extends BaseAction {
  action: "use_gravity_well";
  target_position: GridVec;
}
export interface UseItemAction extends BaseAction {
  action: "use_item";
  item_id: string;
}
export interface IdleAction extends BaseAction {
  action: "idle";
}

export type ClientAction =
  | MoveAction
  | MoveToAction
  | AttackAction
  | DodgeAction
  | ShoveAction
  | PlaceMineAction
  | GrappleAction
  | GravityWellAction
  | UseItemAction
  | IdleAction;

export type ClientMessage = AuthMsg | SelectLoadoutMsg | ClientAction;

// ---------------------------------------------------------------------------
// REST payloads
// ---------------------------------------------------------------------------

export interface GenerateKeyResponse {
  api_key: string;
  bot_id: string;
  created_at: string;
  message: string;
}

export interface ArenaStatus {
  status: string;
  bots_connected: number;
  bots_alive: number;
  round_number: number;
  round_time_remaining: number;
  safe_zone_radius: number;
  top_bot: string;
}

/** Live wire fields (verified 2026-07-02): rank, bot_id, name, avatar_color,
 * kills, deaths, elo, best_streak, damage_dealt, rounds_played, round_wins.
 * There is NO kd_ratio or kill_streak on the wire — compute k/d client-side. */
export interface LeaderboardEntry {
  rank?: number;
  bot_id?: string;
  name: string;
  avatar_color?: string;
  elo: number;
  kills: number;
  deaths: number;
  best_streak?: number;
  damage_dealt?: number;
  rounds_played?: number;
  round_wins?: number;
}

export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
  limit: number;
  offset: number;
  period?: string;
  total: number;
}

export interface BountyEntry {
  rank?: number;
  bot_id?: string;
  name: string;
  bounty?: number;
  win_streak?: number;
  status?: string;
}

export interface BountyResponse {
  entries: BountyEntry[];
  total: number;
}

/**
 * GET /api/v1/arena/map — pre-generated during intermission, so the whole
 * static objective layout (pads, hazard rects, teleporter links) is knowable
 * BEFORE round start, not just the terrain grid. Terrain legend (live):
 * '#' wall · '.' ground · 'C' capture pad · 'H' hazard zone · 'T' teleport pad;
 * the bot-setup spec additionally defines 'V' void and '~' water (impassable).
 */
export interface ArenaMapResponse {
  terrain?: string[][];
  width?: number;
  height?: number;
  cell_size?: number;
  legend?: Record<string, string>;
  capture_pads?: (CapturePadState & { type?: string })[];
  teleport_pads?: (TeleportPadState & { type?: string })[];
  hazard_zones?: (HazardZoneState & { type?: string })[];
  /** Active mode — OMITTED during intermission (features_pending: true). */
  game_mode?: GameMode;
  /** This round's carved playable outline (square, circle, caves, ...). */
  map_shape?: string;
  /** True during intermission: terrain/shape are final for the NEXT round but
   * pads/hazards/game_mode arrive only after round_start — fetch again then. */
  features_pending?: boolean;
  status?: string;
  message?: string;
}

/** PUT /api/v1/bot/config body. The nested default_loadout shape is the one
 * the server parses (verified live: flat default_weapon/default_stats fields —
 * the shape the server ECHOES back — are ignored on write). */
export interface BotConfig {
  name: string;
  avatar_color: string;
  default_loadout: LoadoutSelection;
}

/**
 * Presentation-only cosmetics (skins, weapon finishes, attachments) — zero
 * gameplay effect by design ("no-pay-to-win"). Shapes typed loosely: the
 * catalog carries display metadata we don't act on; only slot/id matter for
 * equipping.
 */
export interface CosmeticItem {
  id: string;
  slot?: string;
  name?: string;
  rarity?: string;
  [extra: string]: unknown;
}

/** GET /api/v1/cosmetics/catalog (public). */
export interface CosmeticsCatalogResponse {
  items?: CosmeticItem[];
  entries?: CosmeticItem[];
  [extra: string]: unknown;
}

/** GET /api/v1/bot/cosmetics (auth): owned/locked/equipped per slot. */
export interface BotCosmeticsResponse {
  owned?: CosmeticItem[];
  locked?: CosmeticItem[];
  equipped?: Record<string, string | CosmeticItem | null>;
  [extra: string]: unknown;
}

/** PUT /api/v1/bot/cosmetics body: equip one owned cosmetic by slot. */
export interface EquipCosmeticRequest {
  slot: string;
  cosmetic_id: string;
}

/** GET /api/v1/service-status (public, Cache-Control: no-store) — same
 * broadcast/maintenance payload as the WS frame, minus the `type` field. */
export type ServiceStatusRest = Omit<ServiceStatusMsg, "type"> & { type?: string };

// ---------------------------------------------------------------------------
// Spectator feed (WS /ws/spectator) — public, no auth, one `arena_state` frame
// per tick with the FULL global arena state: every bot (position, hp, target),
// every landmine (position + owner + armed — invisible to enemies in bot fog!),
// all pickups/pads/hazards, kill feed, sudden_death. Field set verified live
// 2026-07-02.
//
// COORDINATES: unlike the bot feed (grid tiles, 0..99), ALL spectator
// positions are WORLD units (0..1999, 20u per tile) — divide by cell size to
// compare with anything from /ws/bot.
// ---------------------------------------------------------------------------

export interface SpectatorBot {
  id: string;
  bot_id?: string;
  name: string;
  /** Team number in team modes; 0 in FFA. */
  team?: number;
  avatar_color: string;
  position: GridVec;
  hp: number;
  max_hp: number;
  weapon: Weapon;
  is_alive: boolean;
  is_dodging: boolean;
  is_stunned: boolean;
  kill_streak: number;
  round_kills: number;
  cooldown_remaining: number;
  facing: GridVec;
  action: string;
  last_action: string;
  /** Who this bot is currently locked onto ("" when none). */
  target_id: string;
  target_position?: GridVec | null;
  grapple_charges: number;
  grapple_cooldown: number;
  gravity_well_charge: number;
  mine_count: number;
  shield_absorb: number;
  is_bounty_target: boolean;
  bounty_token_bonus: number;
  hazard_key_active: boolean;
  hazard_key_ticks: number;
  relay_battery_active: boolean;
  relay_battery_ticks: number;
  brace_ready: boolean;
  bow_charge_ticks: number;
  bow_charge_level: number;
  charged_shot_ready: boolean;
  recently_disrupted_ticks: number;
}

export interface SpectatorLandmine {
  id: string;
  position: GridVec;
  owner_id: string;
  armed: boolean;
}

/** Collections are OMITTED when empty (no `landmines` key when no mines) —
 * every array here must be read with `?? []`. */
export interface SpectatorArenaState {
  type: "arena_state";
  tick: number;
  round_tick: number;
  sudden_death?: boolean;
  game_mode?: GameMode;
  map_shape?: string;
  /** Team modes: string-keyed team number -> score. */
  team_scores?: Record<string, number>;
  /** CTF: every team flag (WORLD coordinates, like all spectator positions). */
  flags?: FlagState[];
  bots?: SpectatorBot[];
  pickups?: (NearbyPickup & { id?: string })[];
  landmines?: SpectatorLandmine[];
  obstacles?: { x: number; y: number; width: number; height: number }[];
  capture_pads?: (CapturePadState & { type?: string })[];
  teleport_pads?: (TeleportPadState & { type?: string })[];
  hazard_zones?: (HazardZoneState & { type?: string })[];
  kill_feed?: KillFeedEntry[];
  safe_zone?: SafeZone;
  waiting_bots?: { name: string; avatar_color: string; weapon: Weapon }[];
}

/** Live weapon-balance telemetry from GET /api/v1/weapon-stats. Weapons are
 * dynamically balanced, so tier/meta_score/damage change round to round.
 * The live payload carries ~40 fields per entry; typed here are the ones the
 * Brain's meta reasoning uses (rest pass through untyped). */
export interface WeaponStatEntry {
  weapon: Weapon;
  rank?: number;
  tier: string; // S | A | B | C | ...
  meta_score: number;
  /** 0-100 short-window form score — hotter signal than lifetime meta_score. */
  recent_form?: number;
  /** 0-1 confidence in the recent_form sample (few rounds = low). */
  recent_confidence?: number;
  damage_exact?: number;
  cooldown?: number;
  grid_range?: number;
  balance_direction?: string; // buffing | nerfing | steady
  hit_rate?: number;
  damage_per_hit?: number;
  kills_1h?: number;
  special?: string;
}

export interface WeaponStatsResponse {
  entries: WeaponStatEntry[];
  updated_at?: string;
}

export interface BotStats {
  bot_id: string;
  name: string;
  elo: number;
  rank?: number;
  kills: number;
  deaths: number;
  kd_ratio: number;
  assists?: number;
  current_streak?: number;
  best_streak: number;
  damage_dealt: number;
  damage_taken?: number;
  rounds_played: number;
  round_wins: number;
  pickups_collected?: number;
  distance_traveled?: number;
  time_alive_seconds?: number;
  longest_life_secs?: number;
}

/**
 * GET /api/v1/bot/live — real live shape (verified 2026-07-02 against the
 * server and the dashboard's own consumer). Offline: {bot_id, name, online:
 * false, message}. Online adds the round-scoped fields below; action_counts
 * is a per-action histogram of what the server actually registered from us —
 * a useful self-check that intended actions are landing.
 */
export interface BotLiveState {
  bot_id?: string;
  name?: string;
  online: boolean;
  message?: string;
  is_alive?: boolean;
  phase?: string;
  hp?: number;
  max_hp?: number;
  action_counts?: Record<string, number>;
  round_kills?: number;
  round_deaths?: number;
  round_damage_dealt?: number;
  round_damage_taken?: number;
  accuracy?: number;
  round_pickups?: number;
  round_distance?: number;
  kill_streak?: number;
}
