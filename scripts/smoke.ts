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
import { Coalition } from "../src/engine/coop";
import { Channels } from "../src/bus";
import { MemoryBus } from "../src/bus/memory";
import { scoped } from "../src/bus";
import { normalizeStats } from "../src/shared/stats";
import { chooseFallbackLoadout } from "../src/engine/loadout";
import { DEFAULT_DIRECTIVE, DEFAULT_POLICY, mergePolicy } from "../src/types/internal";
import { tradeAdvantage } from "../src/engine/combatMath";
import { PolicyPatchSchema, StrategyOutputSchema, AnalystOutputSchema } from "../src/brain/agents/schemas";
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

function tickFrom(s: SelfState, enemies: NearbyBot[] = [], tickNum = 100): TickMsg {
  return {
    type: "tick",
    tick: tickNum,
    tick_number: tickNum,
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

  console.log("\nSpatial & combat intelligence");
  {
    const ctxOf = (g: GameState) => ({ gs: g, directive: DEFAULT_DIRECTIVE, policy: DEFAULT_POLICY, tick: g.tick });

    // Target leading: an enemy moving -col is predicted ahead of its last tile.
    const gp = freshGameState();
    gp.applyTick(tickFrom(self(), [enemy({ position: [60, 50] })], 100));
    gp.applyTick(tickFrom(self(), [enemy({ position: [56, 50] })], 110)); // moved -4 over 10 ticks
    const en = gp.enemies()[0]!;
    const pred = gp.predictEnemyPos(en, 5);
    check("prediction leads a moving target (-col)", pred[0] < 56, pred);

    // Trade evaluator: favourable vs a lone weak enemy, unfavourable when ganked.
    const gf = freshGameState();
    gf.applyTick(tickFrom(self(), [enemy({ hp: 30, position: [51, 50] })]));
    check("trade vs lone weak enemy is favourable", tradeAdvantage(ctxOf(gf), gf.enemies()[0]!) > 0);

    const gu = freshGameState();
    gu.applyTick(
      tickFrom(self(), [
        enemy({ bot_id: "t", hp: 220, max_hp: 240, position: [52, 50], can_attack: true }),
        enemy({ bot_id: "g1", position: [51, 49], can_attack: true }),
        enemy({ bot_id: "g2", position: [51, 51], can_attack: true }),
      ]),
    );
    const tanky = gu.enemies().find((e) => e.bot_id === "t")!;
    check("trade vs tanky target while ganked is unfavourable", tradeAdvantage(ctxOf(gu), tanky) < 0);

    // Threat field: safest step heads away from a one-sided enemy cluster.
    const step = gu.threatField().safestStep([50, 50], (c, r) => gu.isPassable(c, r));
    check("threat field steps away from the cluster (-col)", step !== null && step[0] <= 0, step);

    // Tactical disengage: only when HURT does a losing, un-pinned fight yield a
    // move instead of an attack (healthy bots commit — the anti-passive change).
    const ctl = new Controller();
    const hurt = freshGameState();
    hurt.applyTick(
      tickFrom(self({ hp: 64, max_hp: 160 }), [
        enemy({ bot_id: "t", hp: 220, max_hp: 240, position: [52, 50], can_attack: true }),
        enemy({ bot_id: "g1", position: [51, 49], can_attack: true }),
        enemy({ bot_id: "g2", position: [51, 51], can_attack: true }),
      ]),
    );
    const a = ctl.decide(hurt);
    check("losing trade while HURT -> disengage (move, not attack)", a.action === "move" || a.action === "move_to", a);

    // Healthy in the same spot -> commit to the fight (no longer over-defensive).
    const b = ctl.decide(gu);
    check("losing trade while HEALTHY -> engages (not a plain retreat move)", b.action !== "move", b);
  }

  console.log("\nEnginePolicy (live LLM tuning)");
  {
    // mergePolicy clamps wild LLM values into safe ranges and bumps the version.
    const merged = mergePolicy(DEFAULT_POLICY, {
      dodgeEagerness: 9,
      kiteRangeBias: -99,
      mineCooldownTicks: 1,
    });
    check("mergePolicy clamps dodgeEagerness <= 1", merged.dodgeEagerness <= 1, merged.dodgeEagerness);
    check("mergePolicy clamps kiteRangeBias >= -3", merged.kiteRangeBias >= -3, merged.kiteRangeBias);
    check("mergePolicy bumps version", merged.version === DEFAULT_POLICY.version + 1, merged.version);

    // A live policy swap changes a real decision WITHOUT restart.
    const ctl = new Controller();
    const meleePressure = () => {
      const g = freshGameState();
      g.applyTick(
        tickFrom(self({ weapon_ready: false, dodge_cooldown: 0 }), [
          enemy({ position: [51, 50], can_attack: true }),
        ]),
      );
      return g;
    };

    ctl.setPolicy({ ...DEFAULT_POLICY, dodgeEagerness: 0.6 });
    const eager = ctl.decide(meleePressure());
    check("dodgeEagerness 0.6 -> dodges melee pressure", eager.action === "dodge", eager);

    ctl.setPolicy({ ...DEFAULT_POLICY, dodgeEagerness: 0 });
    const calm = ctl.decide(meleePressure());
    check("dodgeEagerness 0 -> does NOT dodge (re-tuned live, no restart)", calm.action !== "dodge", calm);

    // Tuner-controlled posture + per-weapon tactics in the policy.
    const m2 = mergePolicy(DEFAULT_POLICY, { aggression: 0.9, posture: "aggressive", daggerFlank: false });
    check("mergePolicy carries aggression", m2.aggression === 0.9, m2.aggression);
    check("mergePolicy carries posture", m2.posture === "aggressive", m2.posture);
    check("mergePolicy carries per-weapon toggle", m2.daggerFlank === false, m2.daggerFlank);
    const mBad = mergePolicy(DEFAULT_POLICY, { posture: "garbage" as never });
    check("mergePolicy rejects invalid posture", mBad.posture === DEFAULT_POLICY.posture, mBad.posture);

    // Policy posture drives behaviour (deterministic, no live tactical directive):
    // adjacent enemy while our weapon cools -> aggressive shoves, defensive backs off.
    const cooling = () => {
      const g = freshGameState();
      g.applyTick(tickFrom(self({ weapon_ready: false, dodge_cooldown: 5 }), [enemy({ position: [51, 50] })]));
      return g;
    };
    ctl.setPolicy({ ...DEFAULT_POLICY, posture: "aggressive" });
    const aggro = ctl.decide(cooling());
    check("policy posture aggressive -> shove", aggro.action === "shove", aggro);
    ctl.setPolicy({ ...DEFAULT_POLICY, posture: "defensive" });
    const defen = ctl.decide(cooling());
    check("policy posture defensive -> not shove (Tuner controls posture)", defen.action !== "shove", defen);
  }

  console.log("\nAgent output leniency (no dropped decisions)");
  {
    // Over-long reasoning must NOT reject the whole Tuner patch (the reported bug).
    const p = PolicyPatchSchema.safeParse({ dodgeEagerness: 0.7, reasoning: "x".repeat(1200) });
    check("tuner patch with 1200-char reasoning parses", p.success, p.success ? "ok" : p.error?.issues?.[0]);
    check("...and reasoning is truncated", p.success === true && p.data.reasoning.length <= 300, p.success && p.data.reasoning.length);

    // Out-of-range numbers get clamped, not rejected.
    const s = StrategyOutputSchema.safeParse({
      posture: "aggressive",
      objective: "free_for_all",
      aggression: 5, // > 1
      hpRetreatFraction: -3, // < 0
      avoidTargetIds: Array.from({ length: 20 }, (_, i) => `bot${i}`), // > 8
      reasoning: "y".repeat(900),
    });
    check("strategy output with bad numbers parses", s.success, s.success ? "ok" : s.error?.issues?.[0]);
    check("...aggression clamped to <=1", s.success === true && s.data.aggression <= 1, s.success && s.data.aggression);
    check("...avoidTargetIds clamped to <=8", s.success === true && s.data.avoidTargetIds.length <= 8, s.success && s.data.avoidTargetIds.length);

    // Analyst lessons over the item/length caps are truncated, not rejected.
    const a = AnalystOutputSchema.safeParse({ lessons: Array.from({ length: 12 }, () => "z".repeat(500)) });
    check("analyst output with too many long lessons parses", a.success, a.success ? "ok" : a.error?.issues?.[0]);
    check("...lessons clamped to <=6", a.success === true && a.data.lessons.length <= 6, a.success && a.data.lessons.length);
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

  console.log("\nScopedBus (parallel-bot isolation)");
  {
    const root = new MemoryBus();
    const a = scoped(root, "bot0:");
    const b = scoped(root, "bot1:");
    let gotA: { v: number } | null = null;
    let gotB: { v: number } | null = null;
    await a.subscribe<{ v: number }>("arena:directive", (p) => { gotA = p; });
    await b.subscribe<{ v: number }>("arena:directive", (p) => { gotB = p; });
    await a.publish("arena:directive", { v: 1 });
    await new Promise((r) => setTimeout(r, 10));
    check("scoped publish reaches its own scope", gotA !== null && (gotA as { v: number }).v === 1, gotA);
    check("scoped publish isolated from other bot", gotB === null, gotB);
    await a.setKV("arena:kv:policy", { p: "A" });
    check("scoped KV isolated across bots", (await b.getKV("arena:kv:policy")) === null);
    check("scoped KV readable in same scope", ((await a.getKV<{ p: string }>("arena:kv:policy"))?.p) === "A");
    await root.close();
  }

  console.log("\nBOT_COOP coalition");
  {
    // GameState drops coalition allies from its enemy view.
    const gs = freshGameState(); // selfId = "me"
    gs.applyTick(
      tickFrom(self(), [
        enemy({ bot_id: "ally", position: [51, 50] }),
        enemy({ bot_id: "foe", position: [52, 50] }),
      ]),
    );
    check("enemies() sees both bots before friendlies set", gs.enemies().length === 2, gs.enemies().map((e) => e.bot_id));
    gs.setFriendlies(new Set(["ally"]));
    const afterFilter = gs.enemies();
    check("enemies() excludes a friendly ally", afterFilter.length === 1 && afterFilter[0]!.bot_id === "foe", afterFilter.map((e) => e.bot_id));

    // Three bots on one GLOBAL bus form a coalition. They learn each other's ids
    // (friendlies), pool enemy sightings, and focus the lowest-HP non-ally.
    const bus = new MemoryBus();
    const coopA = new Coalition(bus, () => "A");
    const coopB = new Coalition(bus, () => "B");
    const coopC = new Coalition(bus, () => "C");
    await coopA.start();
    await coopB.start();
    await coopC.start();

    const pos = [0, 0] as [number, number];
    coopA.report({ ts: Date.now(), botId: "A", name: "A", pos, hp: 100, enemies: [{ id: "e1", hp: 80, pos }, { id: "e2", hp: 30, pos }], focusVote: "e2" });
    // C mistakenly reports ally "A" as an enemy at 1 HP — the coalition must NOT
    // focus-fire it (guards against a friendly-classification race).
    coopC.report({ ts: Date.now(), botId: "C", name: "C", pos, hp: 100, enemies: [{ id: "A", hp: 1, pos }, { id: "e9", hp: 40, pos }], focusVote: "A" });
    await new Promise((r) => setTimeout(r, 10)); // flush pub/sub

    check("B learns allies A and C (friendlyIds)", coopB.friendlyIds().has("A") && coopB.friendlyIds().has("C"), [...coopB.friendlyIds()]);
    check("a bot does not list itself as a friendly", !coopA.friendlyIds().has("A"), [...coopA.friendlyIds()]);
    check("coalition focus = lowest-HP true enemy (e2 @30)", coopB.focus() === "e2", coopB.focus());
    check("coalition never focus-fires a friendly (skips A @1)", coopB.focus() !== "A", coopB.focus());
    check("pooled intel crosses the fog (B sees A-reported e2)", coopB.focus() === "e2", coopB.focus());

    // Coalition rides the global channel, not a per-bot scope.
    check("coalition uses the global coop channel", Channels.coop === "arena:coop", Channels.coop);
    coopA.stop();
    coopB.stop();
    coopC.stop();
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
