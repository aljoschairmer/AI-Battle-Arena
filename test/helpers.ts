/**
 * Shared scenario builders for the unit tests — the same shapes the smoke
 * suite (scripts/smoke.ts) uses to drive the engine offline: a fully-populated
 * SelfState/NearbyBot with every field the live server sends, overridable per
 * test.
 */
import { GameState } from "../src/engine/gameState";
import type {
  ConnectedMsg,
  NearbyBot,
  NearbyEntity,
  NearbyPickup,
  SelfState,
  TickMsg,
} from "../src/types/protocol";

export function self(overrides: Partial<SelfState> = {}): SelfState {
  return {
    bot_id: "me",
    position: [50, 50],
    hp: 160,
    max_hp: 160,
    speed: 6,
    weapon: "sword",
    cooldown_remaining: 0,
    weapon_ready: true,
    is_alive: true,
    kill_streak: 0,
    round_kills: 0,
    dodge_cooldown: 5, // not ready by default so dodge doesn't pre-empt tests
    invuln_ticks: 0,
    stun_ticks: 0,
    facing: [0, 1],
    recently_disrupted_ticks: 0,
    brace_ready: false,
    bow_charge_ticks: 0,
    bow_charge_level: 0,
    charged_shot_ready: false,
    hazard_key_active: false,
    hazard_key_ticks: 0,
    bounty_token_bonus: 0,
    shield_absorb: 0,
    effects: [],
    last_action_result: null,
    hits_received: [],
    kill_feed: [],
    in_safe_zone: true,
    distance_to_zone_edge: 25,
    zone_radius: 40,
    zone_center: [50, 50],
    zone_target_center: [50, 50],
    zone_target_radius: 9,
    grapple_charges: 0,
    grapple_cooldown: 0,
    ...overrides,
  };
}

export function enemy(overrides: Partial<NearbyBot> = {}): NearbyBot {
  return {
    type: "bot",
    bot_id: "enemy1",
    name: "Foe",
    position: [51, 50],
    hp: 100,
    max_hp: 160,
    weapon: "sword",
    is_alive: true,
    avatar_color: "#ff0000",
    last_action: "idle",
    is_dodging: false,
    is_stunned: false,
    facing: [-1, 0],
    recently_disrupted_ticks: 0,
    brace_ready: false,
    bow_charge_level: 0,
    charged_shot_ready: false,
    rear_exposed: false,
    near_impact_surface: false,
    has_los: true,
    attack_range: 1,
    can_attack: true,
    threat_score: 50,
    ...overrides,
  };
}

export function pickup(overrides: Partial<NearbyPickup> = {}): NearbyPickup {
  return {
    type: "pickup",
    pickup_id: "p1",
    pickup_type: "health_pack",
    position: [55, 50],
    ...overrides,
  };
}

export function tickFrom(s: SelfState, entities: NearbyEntity[] = [], tickNum = 100): TickMsg {
  return {
    type: "tick",
    tick: tickNum,
    tick_number: tickNum,
    fog_radius: 7,
    your_state: s,
    nearby_mines: 0,
    nearby_entities: entities,
    safe_zone: {
      center: s.zone_center,
      radius: s.zone_radius,
      target_center: s.zone_target_center,
      target_radius: s.zone_target_radius,
    },
  };
}

export function freshGameState(): GameState {
  const gs = new GameState();
  const connected: ConnectedMsg = {
    type: "connected",
    bot_id: "me",
    arena_size: [2000, 2000],
    grid_size: [100, 100],
    cell_size: 20,
    fog_radius: 7,
    available_weapons: ["sword", "bow", "daggers", "shield", "spear", "staff", "grapple"],
    stat_budget: 20,
    stat_min: 1,
    stat_max: 10,
    timeout_seconds: 10,
    last_loadout: null,
  };
  gs.applyConnected(connected);
  gs.setConfirmedAttackRange(1);
  return gs;
}
