/* eslint-disable no-console */
/**
 * Offline smoke test — exercises the deterministic engine, the bus, and the
 * loadout/stat helpers WITHOUT connecting to the live arena or calling any LLM.
 *
 *   npx tsx scripts/smoke.ts
 *
 * Exits non-zero if any assertion fails. This is the fast way to confirm the
 * core decision logic still works after a change.
 */
import { Controller } from "../src/engine/controller";
import { GameState } from "../src/engine/gameState";
import { MemoryBus } from "../src/bus/memory";
import { normalizeStats } from "../src/shared/stats";
import { chooseFallbackLoadout } from "../src/engine/loadout";
import type {
  ConnectedMsg,
  NearbyBot,
  SelfState,
  TickMsg,
  Weapon,
} from "../src/types/protocol";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}`, extra ?? "");
  }
}

// --- builders --------------------------------------------------------------

function self(overrides: Partial<SelfState> = {}): SelfState {
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

function enemy(overrides: Partial<NearbyBot> = {}): NearbyBot {
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

function tickFrom(s: SelfState, enemies: NearbyBot[] = []): TickMsg {
  return {
    type: "tick",
    tick: 100,
    tick_number: 100,
    fog_radius: 7,
    your_state: s,
    nearby_mines: 0,
    nearby_entities: enemies,
    safe_zone: {
      center: s.zone_center,
      radius: s.zone_radius,
      target_center: s.zone_target_center,
      target_radius: s.zone_target_radius,
    },
  };
}

function freshGameState(): GameState {
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

// --- tests -----------------------------------------------------------------

async function run(): Promise<void> {
  console.log("\nnormalizeStats");
  {
    const a = normalizeStats({ hp: 99, speed: 0, attack: 5, defense: 5 });
    const sumA = a.hp + a.speed + a.attack + a.defense;
    check("clamps + sums to budget (20)", sumA === 20, a);
    check("respects max 10", Math.max(a.hp, a.speed, a.attack, a.defense) <= 10, a);
    check("respects min 1", Math.min(a.hp, a.speed, a.attack, a.defense) >= 1, a);

    const b = normalizeStats({ hp: 1, speed: 1, attack: 1, defense: 1 });
    check("pads up to budget", b.hp + b.speed + b.attack + b.defense === 20, b);
  }

  console.log("\nchooseFallbackLoadout");
  {
    const validFallbacks = ["aggressive", "defensive", "opportunistic", "territorial", "hunter"];
    const lo = chooseFallbackLoadout({ modifier: "hazard_storm" });
    const s = lo.stats;
    check("valid weapon", ["sword", "bow", "daggers", "shield", "spear", "staff", "grapple"].includes(lo.weapon));
    check("stats sum to 20", s.hp + s.speed + s.attack + s.defense === 20, s);
    // Gap 1: fallback_behavior must be one of the 5 server-accepted values (never "balanced").
    check(`fallback_behavior is a valid server value (${lo.fallback_behavior})`, validFallbacks.includes(lo.fallback_behavior), lo.fallback_behavior);
  }

  console.log("\nController decisions");
  {
    const ctl = new Controller();
    ctl.onRoundStart();

    // 1. Outside the safe zone -> head back to centre.
    const gs1 = freshGameState();
    gs1.applyTick(tickFrom(self({ in_safe_zone: false, position: [90, 90], zone_center: [50, 50] })));
    const a1 = ctl.decide(gs1);
    check("outside zone -> move_to zone centre", a1.action === "move_to", a1);

    // 2. Healthy, enemy adjacent, weapon ready -> attack it.
    const gs2 = freshGameState();
    gs2.applyTick(tickFrom(self(), [enemy({ position: [51, 50] })]));
    const a2 = ctl.decide(gs2);
    check("adjacent enemy + weapon ready -> attack", a2.action === "attack", a2);
    check("attacks the right target", a2.action === "attack" && a2.target === "enemy1", a2);

    // 3. Enemy out of melee range, no grapple charges -> approach via move_to.
    const gs3 = freshGameState();
    gs3.applyTick(tickFrom(self({ grapple_charges: 0 }), [enemy({ position: [55, 50] })]));
    const a3 = ctl.decide(gs3);
    check("far enemy (melee, no grapple) -> move_to approach", a3.action === "move_to", a3);

    // 4. Same but with grapple charges -> close the gap with a grapple.
    const gs4 = freshGameState();
    gs4.applyTick(tickFrom(self({ grapple_charges: 2 }), [enemy({ position: [55, 50] })]));
    const a4 = ctl.decide(gs4);
    check("far enemy + grapple charge -> grapple", a4.action === "grapple", a4);

    // 5. Low HP with a chaser nearby -> survive, never trade blows. Acceptable
    //    survival actions: kite (move/move_to) or mine the path behind us.
    const gs5 = freshGameState();
    gs5.applyTick(tickFrom(self({ hp: 16, max_hp: 160 }), [enemy({ position: [52, 50] })]));
    const a5 = ctl.decide(gs5);
    check(
      "low HP -> survive (move/move_to/place_mine), never attack",
      ["move", "move_to", "place_mine", "dodge"].includes(a5.action),
      a5,
    );
    check("low HP -> not attacking", a5.action !== "attack", a5);

    // 6. Incoming charged shot, dodge ready -> dodge.
    const gs6 = freshGameState();
    gs6.applyTick(
      tickFrom(self({ dodge_cooldown: 0, weapon_ready: false }), [
        enemy({ weapon: "bow", position: [54, 50], attack_range: 7, charged_shot_ready: true }),
      ]),
    );
    const a6 = ctl.decide(gs6);
    check("charged shot incoming + dodge ready -> dodge", a6.action === "dodge", a6);

    // 7. Stunned -> idle.
    const gs7 = freshGameState();
    gs7.applyTick(tickFrom(self({ stun_ticks: 3 }), [enemy()]));
    const a7 = ctl.decide(gs7);
    check("stunned -> idle", a7.action === "idle", a7);

    // 8. Gap 2: staff in range -> attack with target_position (AoE placement).
    const gs8 = freshGameState();
    gs8.setConfirmedAttackRange(5);
    gs8.applyTick(
      tickFrom(self({ weapon: "staff", grapple_charges: 0 }), [enemy({ position: [54, 50] })]),
    );
    const a8 = ctl.decide(gs8);
    check("staff in range -> attack", a8.action === "attack", a8);
    check(
      "staff attack carries target_position (AoE)",
      a8.action === "attack" && Array.isArray((a8 as { target_position?: unknown }).target_position),
      a8,
    );

    // 9. Gap 3: no enemies in fog + server bot-hint -> move toward the hint.
    const gs9 = freshGameState();
    gs9.applyTick(tickFrom(self({ position: [50, 50] }), [])); // no entities
    gs9.hints = [{ hint_type: "bot", direction: [1, 0], distance: 200 }];
    const a9 = ctl.decide(gs9);
    check("nav hint -> move_to", a9.action === "move_to", a9);
    check(
      "nav hint -> moves toward the hinted direction (+col)",
      a9.action === "move_to" && (a9 as { target_position: [number, number] }).target_position[0] > 50,
      a9,
    );
  }

  console.log("\nMemoryBus");
  {
    const bus = new MemoryBus();
    let got: { n: number } | null = null;
    const unsub = await bus.subscribe<{ n: number }>("ch", (p) => {
      got = p;
    });
    await bus.publish("ch", { n: 42 });
    await new Promise((r) => setTimeout(r, 10)); // let the microtask flush
    check("pub/sub round trip", got !== null && (got as { n: number }).n === 42, got);
    unsub();
    await bus.setKV("k", { v: "hello" });
    const kv = await bus.getKV<{ v: string }>("k");
    check("KV set/get", kv?.v === "hello", kv);
    await bus.close();
  }

  console.log("");
  if (failures > 0) {
    console.error(`SMOKE FAILED: ${failures} assertion(s) failed\n`);
    process.exit(1);
  }
  console.log("SMOKE PASSED ✓ all assertions green\n");
}

run().catch((e) => {
  console.error("smoke crashed:", e);
  process.exit(1);
});
