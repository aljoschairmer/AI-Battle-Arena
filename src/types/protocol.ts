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

export type FallbackBehavior = "aggressive" | "defensive" | "balanced";

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
  countdown: number;
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
  bounty_token_bonus: number;
  shield_absorb: number;
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
  bow_charge_level: number;
  charged_shot_ready: boolean;
  rear_exposed: boolean;
  near_impact_surface: boolean;
  has_los: boolean;
  attack_range: number;
  can_attack: boolean;
  threat_score: number;
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
  | NearbyHazard;

export interface TickMsg {
  type: "tick";
  tick: number;
  tick_number: number;
  fog_radius: number;
  your_state: SelfState;
  nearby_mines: number;
  nearby_entities: NearbyEntity[];
  safe_zone: SafeZone;
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
  | KickMsg;

// ---------------------------------------------------------------------------
// Bot -> Server messages
// ---------------------------------------------------------------------------

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
  charged?: boolean;
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

export type ClientMessage = SelectLoadoutMsg | ClientAction;

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

export interface LeaderboardEntry {
  rank?: number;
  bot_id?: string;
  name: string;
  elo: number;
  kills: number;
  deaths: number;
  kd_ratio?: number;
  kill_streak?: number;
  rounds_played?: number;
  round_wins?: number;
}

export interface LeaderboardResponse {
  leaderboard: LeaderboardEntry[];
  limit: number;
  offset: number;
  period: string;
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

export interface ArenaMapResponse {
  terrain?: string[][];
  status?: string;
  message?: string;
}

export interface BotConfig {
  name: string;
  avatar_color: string;
  default_loadout: LoadoutSelection;
}
