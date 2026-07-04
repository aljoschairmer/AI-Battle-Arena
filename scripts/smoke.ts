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
import { retreatAndHeal, survivalBehavior, tacticalDisengage } from "../src/engine/behaviors/survival";
import { combatBehavior } from "../src/engine/behaviors/combat";
import { flankingPosition, grabPickup } from "../src/engine/behaviors/movement";
import { selectTarget } from "../src/engine/behaviors/targeting";
import { Coalition, onlyFleetRemains, onlyFleetRemainsByCount } from "../src/engine/coop";
import { Channels } from "../src/bus";
import { MemoryBus } from "../src/bus/memory";
import { scoped } from "../src/bus";
import { normalizeStats } from "../src/shared/stats";
import { chooseFallbackLoadout } from "../src/engine/loadout";
import {
  DEFAULT_DIRECTIVE,
  DEFAULT_POLICY,
  isFresher,
  mergePolicy,
  parsePolicyOverrides,
  sanitizePolicy,
  shouldApplyDirective,
  type Directive,
  type EnginePolicy,
} from "../src/types/internal";
import { TokenBucket } from "../src/shared/ratelimit";
import { classifyCauseOfDeath, OutcomeLog } from "../src/engine/outcomeLog";
import { TelemetryLog } from "../src/engine/telemetryLog";
import { LoadoutAgent, type LoadoutAgentInput } from "../src/brain/agents/loadout";
import { StrategistAgent } from "../src/brain/agents/strategist";
import { enforceWeaponEvidence, fleetWeaponWinRatesFromDisk } from "../src/brain/draftEvidence";
import { DEFAULT_INSIGHTS, OpponentRegistry, RoundHistory } from "../src/shared/memory";
import { BrainMemoryStore } from "../src/shared/memoryStore";
import { dumpKnowledge, restoreKnowledge } from "../src/shared/knowledge";
import { OpenRouter } from "../src/brain/openrouter";
import type { GameSnapshot, LoadoutRequest } from "../src/types/internal";
import { TacticianAgent } from "../src/brain/agents/tactician";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isServerMessageType } from "../src/arena/ws";
import { deriveStats, damagePerHit, dpsInto, fightPower, optimizeBuild } from "../src/shared/derived";
import { WEAPONS } from "../src/engine/weapons";
import { matchupRating, counterScore, rankCounterPicks } from "../src/engine/matchups";
import { tradeAdvantage } from "../src/engine/combatMath";
import { findPath } from "../src/engine/pathfinding";
import { chebyshev } from "../src/shared/geometry";
import { PolicyPatchSchema, StrategyOutputSchema, AnalystOutputSchema } from "../src/brain/agents/schemas";
import type {
  ConnectedMsg,
  NearbyBot,
  NearbyEntity,
  NearbyPickup,
  RoundStartMsg,
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

function pickup(overrides: Partial<NearbyPickup> = {}): NearbyPickup {
  return {
    type: "pickup",
    pickup_id: "p1",
    pickup_type: "health_pack",
    position: [55, 50],
    ...overrides,
  };
}

function tickFrom(s: SelfState, entities: NearbyEntity[] = [], tickNum = 100): TickMsg {
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

    // 1. Outside the safe zone, no threats nearby -> step toward centre via the
    //    threat field (a single "move" now, not a blind "move_to" — see below).
    const gs1 = freshGameState();
    gs1.applyTick(tickFrom(self({ in_safe_zone: false, position: [90, 90], zone_center: [50, 50] })));
    const a1 = ctl.decide(gs1);
    check("outside zone, no threats -> move (threat-field step)", a1.action === "move", a1);
    check(
      "...step direction reduces distance to zone centre",
      a1.action === "move" && a1.direction[0] <= 0 && a1.direction[1] <= 0,
      a1,
    );

    // 1b. Outside the zone with a dangerous enemy sitting directly on the
    // straight line to zone centre -> must NOT step toward/adjacent to it (the
    // bug this regression-tests: survivalBehavior's zone-return used to be a
    // raw moveTo(zone_center) with zero threat-field consultation, meaning it
    // could walk straight through an enemy's coverage to get back in).
    const gs1b = freshGameState();
    gs1b.applyTick(
      tickFrom(
        self({ in_safe_zone: false, position: [90, 50], zone_center: [50, 50], zone_radius: 20 }),
        [enemy({ position: [88, 50] })], // directly between self and zone centre
      ),
    );
    const a1b = ctl.decide(gs1b);
    check("outside zone + enemy on the direct path -> still a threat-field move", a1b.action === "move", a1b);
    if (a1b.action === "move") {
      const landing: [number, number] = [90 + a1b.direction[0], 50 + a1b.direction[1]];
      check(
        "...does not step adjacent to the enemy blocking the straight line",
        chebyshev(landing, [88, 50]) > 1,
        landing,
      );
    }

    // 1c. Outside the zone AND a charged shot is already lined up on us ->
    // must dodge, not blindly walk toward zone centre. Regression test for:
    // survivalBehavior's zone-return used to unconditionally claim the tick
    // BEFORE emergencyDodge (priority 2 vs 3) ever ran, so this exact
    // situation was structurally unreachable — the dodge action existed but
    // the pipeline could never reach it while out of zone.
    const gs1c = freshGameState();
    gs1c.applyTick(
      tickFrom(
        self({ in_safe_zone: false, position: [90, 50], zone_center: [50, 50], dodge_cooldown: 0, weapon_ready: false }),
        [enemy({ weapon: "bow", position: [92, 50], attack_range: 7, charged_shot_ready: true })],
      ),
    );
    const a1c = ctl.decide(gs1c);
    check(
      "outside zone + charged shot lined up -> dodges (was structurally unreachable)",
      a1c.action === "dodge",
      a1c,
    );

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

  console.log("\nDowntime self-care: hints + capture pads (pass-2 follow-up)");
  {
    const ctl = new Controller();
    ctl.setPolicy(DEFAULT_POLICY);
    ctl.onRoundStart();

    // Hurt + quiet arena + both hint types known -> follows the HEALTH pickup
    // hint (west), not the bot hint (east). Old rule: nearest bot hint always
    // won, so a hurt bot marched straight into its next fight.
    const gHurt = freshGameState();
    gHurt.applyTick(tickFrom(self({ hp: 80, max_hp: 160 }), []));
    gHurt.hints = [
      { hint_type: "bot", direction: [1, 0], distance: 200 },
      { hint_type: "pickup", pickup_type: "health_pack", direction: [-1, 0], distance: 300 },
    ];
    const aHurt = ctl.decide(gHurt);
    check(
      "hurt + quiet -> follows health hint, not bot hint",
      aHurt.action === "move_to" && (aHurt as { target_position: [number, number] }).target_position[0] < 50,
      aHurt,
    );

    // Healthy with the bot hint nearer -> still hunts the bot (old behaviour kept).
    const gHealthy = freshGameState();
    gHealthy.applyTick(tickFrom(self(), []));
    gHealthy.hints = [
      { hint_type: "bot", direction: [1, 0], distance: 200 },
      { hint_type: "pickup", pickup_type: "damage_boost", direction: [-1, 0], distance: 300 },
    ];
    const aHealthy = ctl.decide(gHealthy);
    check(
      "healthy + bot hint nearer -> hunts the bot",
      aHealthy.action === "move_to" && (aHealthy as { target_position: [number, number] }).target_position[0] > 50,
      aHealthy,
    );

    // Healthy but a pickup hint strictly closer -> grabs the value on the way.
    const gValue = freshGameState();
    gValue.applyTick(tickFrom(self(), []));
    gValue.hints = [
      { hint_type: "bot", direction: [1, 0], distance: 400 },
      { hint_type: "pickup", pickup_type: "damage_boost", direction: [-1, 0], distance: 100 },
    ];
    const aValue = ctl.decide(gValue);
    check(
      "healthy + pickup hint closer -> collects it first",
      aValue.action === "move_to" && (aValue as { target_position: [number, number] }).target_position[0] < 50,
      aValue,
    );

    // Nothing to fight, loot, or chase — but a capture pad nearby -> heads for
    // the pad instead of patrolling (idleCapturePads). Terrain 'C' at [53,50].
    const gPad = freshGameState();
    const terrain = Array.from({ length: 100 }, () => Array.from({ length: 100 }, () => "."));
    terrain[50]![53] = "C";
    gPad.setTerrain(terrain);
    gPad.applyTick(tickFrom(self(), []));
    const aPad = ctl.decide(gPad);
    check(
      "idle + capture pad nearby -> moves to the pad",
      aPad.action === "move_to" && (aPad as { target_position: [number, number] }).target_position[0] === 53 && (aPad as { target_position: [number, number] }).target_position[1] === 50,
      aPad,
    );
    // Toggle off -> old patrol behaviour (not the pad).
    ctl.setPolicy(mergePolicy(DEFAULT_POLICY, { idleCapturePads: false }));
    const aNoPad = ctl.decide(gPad);
    const noPadTarget = aNoPad.action === "move_to" ? (aNoPad as { target_position: [number, number] }).target_position : null;
    check(
      "idleCapturePads=false -> patrols instead",
      noPadTarget === null || noPadTarget[0] !== 53 || noPadTarget[1] !== 50,
      aNoPad,
    );

    // Clamping for the new knobs.
    const pc = mergePolicy(DEFAULT_POLICY, { idleHealBelowHpFraction: 7 });
    check("mergePolicy clamps idleHealBelowHpFraction <= 1", pc.idleHealBelowHpFraction <= 1, pc.idleHealBelowHpFraction);
  }

  console.log("\nAnti-stuck: low-HP retreat with nothing to retreat from (the ORIGINAL map-centre freeze)");
  {
    const ctxOf = (g: GameState) => ({ gs: g, directive: DEFAULT_DIRECTIVE, policy: DEFAULT_POLICY, tick: g.tick });

    // Low HP, empty fog, no pickups: retreatAndHeal must DEFER (null), not
    // walk to the zone centre and stand there. Pre-fix it returned
    // moveTo(zone_center) forever — and since HP never regenerates, this rung
    // claimed every tick and the heal-finding downtime layer was unreachable.
    const gEmpty = freshGameState();
    gEmpty.applyTick(tickFrom(self({ hp: 20, max_hp: 160, position: [50, 50] }), []));
    check("low HP + empty arena -> retreat defers instead of parking at centre", retreatAndHeal(ctxOf(gEmpty)) === null);

    // …and end-to-end through the controller: the bot MOVES (patrol), it does
    // not emit move_to(its own tile at the zone centre).
    const ctl = new Controller();
    ctl.setPolicy(DEFAULT_POLICY);
    ctl.onRoundStart();
    const aEmpty = ctl.decide(gEmpty);
    const emptyTarget = aEmpty.action === "move_to" ? (aEmpty as { target_position: [number, number] }).target_position : null;
    check(
      "low HP + empty arena -> keeps moving (no own-tile move_to)",
      !(emptyTarget && emptyTarget[0] === 50 && emptyTarget[1] === 50),
      aEmpty,
    );

    // With a health hint available, the low-HP bot can now actually follow it
    // (pre-fix the retreat rung starved followHint of every tick).
    const gHint = freshGameState();
    gHint.applyTick(tickFrom(self({ hp: 20, max_hp: 160, position: [50, 50] }), []));
    gHint.hints = [{ hint_type: "pickup", pickup_type: "health_pack", direction: [-1, 0], distance: 200 }];
    const aHint = ctl.decide(gHint);
    check(
      "low HP + health hint -> hunts the heal (west)",
      aHint.action === "move_to" && (aHint as { target_position: [number, number] }).target_position[0] < 50,
      aHint,
    );

    // A visible chaser still triggers a real retreat (kite step) — deferring
    // only happens when there is literally nothing to retreat from.
    const gChase = freshGameState();
    gChase.applyTick(tickFrom(self({ hp: 20, max_hp: 160 }), [enemy({ position: [52, 50], can_attack: true })]));
    const rChase = retreatAndHeal(ctxOf(gChase));
    check("low HP + visible chaser -> still retreats (kites)", rChase !== null, rChase);
  }

  console.log("\nAnti-stuck: bounded pad parking, ghost forget, serpentine under fire");
  {
    const padTerrain = () => {
      const t = Array.from({ length: 100 }, () => Array.from({ length: 100 }, () => "."));
      t[50]![53] = "C";
      return t;
    };

    // THE stuck-in-the-middle bug: parking on a captured pad forever. Standing
    // on the pad must end after the capture window (~30 consecutive ticks) —
    // the pad goes on cooldown and the bot moves on (patrol), instead of
    // emitting move_to(own tile) until an enemy shows up and kills it.
    const ctl = new Controller();
    ctl.setPolicy(DEFAULT_POLICY);
    ctl.onRoundStart();
    const gPark = freshGameState();
    gPark.setTerrain(padTerrain());
    let leftPad = false;
    let heldPadFirst = false;
    for (let t = 0; t < 40; t++) {
      gPark.applyTick(tickFrom(self({ position: [53, 50] }), [], 600 + t));
      const a = ctl.decide(gPark);
      const tp = a.action === "move_to" ? (a as { target_position: [number, number] }).target_position : null;
      if (t === 0 && tp && tp[0] === 53 && tp[1] === 50) heldPadFirst = true;
      if (!(tp && tp[0] === 53 && tp[1] === 50)) {
        leftPad = true;
        break;
      }
    }
    check("holds the pad while capturing", heldPadFirst);
    check("...but leaves the pad after the capture window (no infinite parking)", leftPad);

    // Under fire from an UNSEEN attacker (bow range 8 > fog 7): never park on
    // the pad or stand — serpentine (a `move`, changing heading) instead.
    const ctlFire = new Controller();
    ctlFire.setPolicy(DEFAULT_POLICY);
    ctlFire.onRoundStart();
    const gFire = freshGameState();
    gFire.setTerrain(padTerrain());
    gFire.applyTick(
      tickFrom(
        self({ position: [53, 50], hp: 120, max_hp: 160, hits_received: [{ attacker_id: "sniper", damage: 20, weapon: "bow" }] }),
        [],
        700,
      ),
    );
    const aFire = ctlFire.decide(gFire);
    check("hit by unseen sniper -> moves (serpentine), never parks on the pad", aFire.action === "move", aFire);
    // The weave flips its strafe component across ticks (tick 700 vs 705 windows).
    gFire.applyTick(tickFrom(self({ position: [53, 50], hp: 120, max_hp: 160 }), [], 705));
    const aFire2 = ctlFire.decide(gFire);
    check(
      "...and keeps weaving on later ticks while the recent-fire window holds",
      aFire2.action === "move" && (aFire.action !== "move" || aFire2.direction[0] !== (aFire as { direction: [number, number] }).direction[0] || aFire2.direction[1] !== (aFire as { direction: [number, number] }).direction[1]),
      { first: aFire, second: aFire2 },
    );

    // Ghost positions are forgotten on arrival instead of being stood upon
    // until the 30-tick memory expires.
    const ctlGhost = new Controller();
    ctlGhost.setPolicy(DEFAULT_POLICY);
    ctlGhost.onRoundStart();
    const gGhost = freshGameState();
    gGhost.applyTick(tickFrom(self({ position: [50, 50] }), [enemy({ bot_id: "ghost", position: [51, 50] })], 800));
    gGhost.applyTick(tickFrom(self({ position: [50, 50] }), [], 801)); // enemy gone, we're adjacent to the memory
    const aGhost = ctlGhost.decide(gGhost);
    const ghostTarget = aGhost.action === "move_to" ? (aGhost as { target_position: [number, number] }).target_position : null;
    check(
      "arrived at a last-seen position with nothing there -> memory dropped, moves elsewhere",
      gGhost.guessedEnemyPositions(30).length === 0 && !(ghostTarget && ghostTarget[0] === 51 && ghostTarget[1] === 50),
      aGhost,
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

  console.log("\nSurvival cluster (Phase 4 fix 1): trade-aware retreat + defensive separation");
  {
    const ctxOf = (g: GameState) => ({ gs: g, directive: DEFAULT_DIRECTIVE, policy: DEFAULT_POLICY, tick: g.tick });

    // Same 20% HP in both cases — only the trade math against the nearest
    // threat differs. Regression test for: retreat threshold used to be a
    // static HP fraction, oblivious to whether the fight is winnable.
    const favorable = freshGameState();
    favorable.applyTick(
      tickFrom(self({ hp: 32, max_hp: 160 }), [enemy({ hp: 5, position: [51, 50], can_attack: true })]),
    );
    const rFav = retreatAndHeal(ctxOf(favorable));
    check("winning trade at 20% HP -> does not retreat purely on HP", rFav === null, rFav);

    const unfavorable = freshGameState();
    unfavorable.applyTick(
      tickFrom(self({ hp: 32, max_hp: 160 }), [
        enemy({ bot_id: "t", hp: 220, max_hp: 240, position: [52, 50], can_attack: true }),
        enemy({ bot_id: "g1", position: [51, 49], can_attack: true }),
        enemy({ bot_id: "g2", position: [51, 51], can_attack: true }),
      ]),
    );
    const rUnfav = retreatAndHeal(ctxOf(unfavorable));
    check("losing/ganked trade at the SAME 20% HP -> does retreat", rUnfav !== null, rUnfav);

    // Cornered: neither the immediate neighbours nor anything within radius 4
    // beats standing still (tiny zone_radius makes every tile off it worse,
    // and the only nearby tiles that dodge that penalty are closer to the
    // threat). Regression test for: grapple/shove previously had NO defensive
    // use path anywhere in the engine — a cornered, confirmed-losing bot just
    // silently fell through to fighting.
    const cornered = freshGameState();
    cornered.applyTick(
      tickFrom(self({ position: [0, 0], zone_center: [0, 0], zone_radius: 1 }), [
        enemy({ position: [1, 1], can_attack: true }),
      ]),
    );
    const bail = tacticalDisengage(ctxOf(cornered));
    check(
      "cornered + adjacent threat -> shoves for separation instead of giving up",
      bail !== null && bail.action === "shove",
      bail,
    );
  }

  console.log("\nRanged fire-while-kiting (pass-2 fix S1)");
  {
    const ctxOf = (g: GameState) => ({ gs: g, directive: DEFAULT_DIRECTIVE, policy: DEFAULT_POLICY, tick: g.tick });

    // A retreating bow with the chaser 4 tiles inside its 8-tile range and the
    // weapon READY must spend the retreat tick shooting, not moving —
    // pre-fix, retreatAndHeal only ever emitted moves, so a fleeing ranged bot
    // never fired again (dominant loss mode in the pass-2 daggers/bow runs).
    const bowKite = () => {
      const g = freshGameState();
      g.setConfirmedAttackRange(8);
      return g;
    };
    const gReady = bowKite();
    gReady.applyTick(
      tickFrom(self({ weapon: "bow", hp: 32, max_hp: 160, weapon_ready: true }), [enemy({ position: [54, 50] })]),
    );
    const rReady = retreatAndHeal(ctxOf(gReady));
    check("retreating bow + weapon ready + chaser in range -> fires", rReady?.action === "attack", rReady);

    const gCooling = bowKite();
    gCooling.applyTick(
      tickFrom(self({ weapon: "bow", hp: 32, max_hp: 160, weapon_ready: false }), [enemy({ position: [54, 50] })]),
    );
    const rCooling = retreatAndHeal(ctxOf(gCooling));
    check("retreating bow + weapon cooling -> still kites (moves)", rCooling !== null && rCooling.action !== "attack", rCooling);

    // Point-blank: don't stand and trade — keep moving.
    const gPointBlank = bowKite();
    gPointBlank.applyTick(
      tickFrom(self({ weapon: "bow", hp: 32, max_hp: 160, weapon_ready: true }), [enemy({ position: [51, 50] })]),
    );
    const rPB = retreatAndHeal(ctxOf(gPointBlank));
    check("retreating bow + chaser point-blank -> moves, not attack", rPB !== null && rPB.action !== "attack", rPB);

    // Melee never fires here (a chaser behind us is out of range by definition).
    const gSword = freshGameState();
    gSword.applyTick(
      tickFrom(self({ weapon: "sword", hp: 32, max_hp: 160, weapon_ready: true }), [enemy({ position: [54, 50] })]),
    );
    const rSword = retreatAndHeal(ctxOf(gSword));
    check("retreating sword -> never attacks from retreat", rSword === null || rSword.action !== "attack", rSword);

    // Tuner can disable it.
    const gOff = bowKite();
    gOff.applyTick(
      tickFrom(self({ weapon: "bow", hp: 32, max_hp: 160, weapon_ready: true }), [enemy({ position: [54, 50] })]),
    );
    const rOff = retreatAndHeal({ gs: gOff, directive: DEFAULT_DIRECTIVE, policy: mergePolicy(DEFAULT_POLICY, { retreatFireWhileKiting: false }), tick: gOff.tick });
    check("retreatFireWhileKiting=false -> back to pure kiting", rOff === null || rOff.action !== "attack", rOff);
  }

  console.log("\nMine placement is bearing-aware, not just proximity (Tier 3 fix)");
  {
    // A single adjacent chaser is, by construction, behind whatever direction
    // we flee it in -> places a mine.
    const ctlMine1 = new Controller();
    ctlMine1.onRoundStart();
    const gsChaserBehind = freshGameState();
    gsChaserBehind.applyTick(tickFrom(self({ hp: 10, max_hp: 160 }), [enemy({ bot_id: "chaser", position: [51, 50] })]));
    const behindResult = ctlMine1.decide(gsChaserBehind);
    check("single chaser adjacent (necessarily behind) -> places a mine", behindResult.action === "place_mine", behindResult);

    // A distant, dominant threat drives the flight direction (verified: a
    // [-1,-1] retreat, away from it); a second, weak enemy sits within
    // mineChaseRange but AHEAD of that direction, not behind it. Regression
    // test for: maybeDropMine used to check only proximity, so this weak
    // bystander directly in our path would have been mined too.
    const ctlMine2 = new Controller();
    ctlMine2.onRoundStart();
    const gsAhead = freshGameState();
    gsAhead.applyTick(
      tickFrom(self({ hp: 10, max_hp: 160 }), [
        enemy({ bot_id: "dominant", position: [56, 50], attack_range: 6, threat_score: 200 }),
        enemy({ bot_id: "westfoe", position: [47, 50], attack_range: 1, threat_score: 1 }),
      ]),
    );
    const aheadResult = ctlMine2.decide(gsAhead);
    check(
      "weak enemy within range but ahead of the retreat direction -> no mine, just kites",
      aheadResult.action === "move",
      aheadResult,
    );
  }

  console.log("\nZone-edge-drift graduated margin (deep dive fix)");
  {
    const zoneSelf = (distanceToEdge: number) =>
      self({
        position: [50, 50],
        hp: 160,
        max_hp: 160,
        weapon_ready: true,
        zone_center: [50, 50],
        zone_radius: 20,
        zone_target_center: [70, 70],
        zone_target_radius: 9,
        distance_to_zone_edge: distanceToEdge,
      });

    // Inside the hard margin (default 2) -> always drifts, even mid a
    // trivially-winning fight. This is the safety floor that must never be
    // skipped (zone damage compounds if ignored).
    const ctlZ1 = new Controller();
    ctlZ1.onRoundStart();
    const gsUrgent = freshGameState();
    gsUrgent.applyTick(tickFrom(zoneSelf(1), [enemy({ hp: 5, position: [51, 50], can_attack: true })]));
    const zUrgent = ctlZ1.decide(gsUrgent);
    check(
      "within hard zone-edge margin -> always drifts, even mid a great fight",
      zUrgent.action === "move_to" && zUrgent.target_position[0] === 70 && zUrgent.target_position[1] === 70,
      zUrgent,
    );

    // In the softer outer band (between hard margin and zoneEdgeMargin) with
    // an active, clearly-winning adjacent fight -> defers to combat instead
    // of interrupting it. Regression test for the deep-dive finding: this
    // used to interrupt 27% of engagements for ~0 measured HP benefit while
    // stretching fight duration ~50%.
    const ctlZ2 = new Controller();
    ctlZ2.onRoundStart();
    const gsSoftFight = freshGameState();
    gsSoftFight.applyTick(tickFrom(zoneSelf(4), [enemy({ hp: 5, position: [51, 50], can_attack: true })]));
    const zSoftFight = ctlZ2.decide(gsSoftFight);
    check("soft band + winning fight -> defers to combat (attacks)", zSoftFight.action === "attack", zSoftFight);

    // Same soft band, but nothing to fight -> still drifts. The soft band
    // only ever defers FOR an active fight, never just skips zone safety.
    const ctlZ3 = new Controller();
    ctlZ3.onRoundStart();
    const gsSoftNoFight = freshGameState();
    gsSoftNoFight.applyTick(tickFrom(zoneSelf(4), []));
    const zSoftNoFight = ctlZ3.decide(gsSoftNoFight);
    check(
      "soft band + no fight -> still drifts",
      zSoftNoFight.action === "move_to" && zSoftNoFight.target_position[0] === 70 && zSoftNoFight.target_position[1] === 70,
      zSoftNoFight,
    );
  }

  console.log("\nPickup safety considers recently-seen enemies (Tier 3 fix)");
  {
    const ctxOf = (g: GameState) => ({ gs: g, directive: DEFAULT_DIRECTIVE, policy: DEFAULT_POLICY, tick: g.tick });

    // grabPickup/seekPickup only ever run with zero CURRENTLY visible enemies
    // (selectTarget claims priority 7 for any visible enemy first) — so their
    // old enemyControls() check was, in practice, always checking an empty
    // list. Regression test for the actually-reachable gap: an enemy seen
    // moments ago right on top of one pickup, now out of fog, should still
    // rule that pickup out — while an unrelated pickup with no such history
    // is still fair game.
    const gsStale = freshGameState();
    gsStale.applyTick(tickFrom(self(), [enemy({ bot_id: "seenfoe", position: [55, 50] })], 100));
    gsStale.applyTick(
      tickFrom(
        self(),
        [pickup({ pickup_id: "risky", position: [55, 50] }), pickup({ pickup_id: "safe", position: [50, 55] })],
        105, // 5 ticks later, enemy no longer visible but well within the default 15-tick window
      ),
    );
    const picked = grabPickup(ctxOf(gsStale));
    check(
      "avoids the pickup where an enemy was seen 5 ticks ago, grabs the unrelated one instead",
      picked?.action === "move_to" && picked.target_position[0] === 50 && picked.target_position[1] === 55,
      picked,
    );
  }

  console.log("\nCombat cooldown step (Phase 4 fix 2): threat-field-aware, not single-target");
  {
    const ctxOf = (g: GameState) => ({ gs: g, directive: DEFAULT_DIRECTIVE, policy: DEFAULT_POLICY, tick: g.tick });

    // Cooling down adjacent to A (at [51,50]) — the naive "step straight away
    // from A" lands at [49,50], which sits well inside a SECOND enemy B's
    // coverage at [48,50]. A threat-field-aware step should prefer one of the
    // perpendicular tiles instead. Regression test for: this branch used to
    // call gs.stepAwayFrom(target.position) considering only the current
    // target, ignoring every other enemy on the field (combat.ts #6).
    const gsCool = freshGameState();
    gsCool.applyTick(
      tickFrom(self({ position: [50, 50], weapon_ready: false, dodge_cooldown: 5 }), [
        enemy({ bot_id: "a", position: [51, 50] }),
        enemy({ bot_id: "b", position: [48, 50] }),
      ]),
    );
    const coolTarget = gsCool.enemies().find((e) => e.bot_id === "a")!;
    const coolAction = combatBehavior(ctxOf(gsCool), coolTarget);
    check("cooling down near A with B further down the retreat line -> steps away", coolAction?.action === "move", coolAction);
    if (coolAction?.action === "move") {
      check(
        "...but not straight away from A (that tile is deeper into B's coverage, not safer)",
        !(coolAction.direction[0] === -1 && coolAction.direction[1] === 0),
        coolAction.direction,
      );
    }
  }

  console.log("\nTarget-switch debounce (Phase 4 fix 3)");
  {
    const ctxOf = (g: GameState) => ({ gs: g, directive: DEFAULT_DIRECTIVE, policy: DEFAULT_POLICY, tick: g.tick });
    const gsT = freshGameState();

    // Tick 1: A is decisively better (much lower HP) -> picks A.
    gsT.applyTick(
      tickFrom(
        self(),
        [
          enemy({ bot_id: "a", hp: 20, max_hp: 160, position: [55, 50] }),
          enemy({ bot_id: "b", hp: 150, max_hp: 160, position: [55, 50] }),
        ],
        100,
      ),
    );
    const t1 = selectTarget(ctxOf(gsT));
    check("tick1: picks the decisively-better target A", t1?.bot_id === "a", t1?.bot_id);

    // Tick 2: B edges ahead by only a few HP worth of score -> regression test
    // for the bug: previously ANY improvement, however small, flipped the
    // target every tick (confirmed thrashing in Phase 2 telemetry). Must stick
    // with A.
    gsT.applyTick(
      tickFrom(
        self(),
        [
          enemy({ bot_id: "a", hp: 90, max_hp: 160, position: [55, 50] }),
          enemy({ bot_id: "b", hp: 85, max_hp: 160, position: [55, 50] }),
        ],
        101,
      ),
    );
    const t2 = selectTarget(ctxOf(gsT));
    check("tick2: B only marginally ahead -> sticks with A (hysteresis)", t2?.bot_id === "a", t2?.bot_id);

    // Tick 3: B pulls far enough ahead (near death) that the margin clears the
    // hysteresis -> a real opportunity still switches, not stuck forever.
    gsT.applyTick(
      tickFrom(
        self(),
        [
          enemy({ bot_id: "a", hp: 90, max_hp: 160, position: [55, 50] }),
          enemy({ bot_id: "b", hp: 10, max_hp: 160, position: [55, 50] }),
        ],
        102,
      ),
    );
    const t3 = selectTarget(ctxOf(gsT));
    check("tick3: B pulls decisively ahead -> switches (clears hysteresis)", t3?.bot_id === "b", t3?.bot_id);
  }

  console.log("\nDagger backstab positioning (Phase 4 fix 4)");
  {
    const ctxOf = (g: GameState) => ({ gs: g, directive: DEFAULT_DIRECTIVE, policy: DEFAULT_POLICY, tick: g.tick });

    // Baseline, unaffected case: already rear-exposed -> attack normally.
    const gsRear = freshGameState();
    gsRear.applyTick(tickFrom(self({ weapon: "daggers" }), [enemy({ position: [51, 50], rear_exposed: true })]));
    const actRear = combatBehavior(ctxOf(gsRear), gsRear.enemies()[0]!);
    check("daggers + rear-exposed target -> attacks normally", actRear?.action === "attack", actRear);

    // Regression test for the dead-code bug: not rear-exposed, and the flank
    // tile is ONE step away -> defer to positionForCombat instead of attacking
    // head-on. The behind tile is now derived from the target's FACING
    // (pass-2 fix M1): enemy at [51,50] facing west ([-1,0]) -> behind is
    // [52,50]; stand at [52,51] so the flank is one step from completion.
    const gsFlank = freshGameState();
    gsFlank.applyTick(
      tickFrom(self({ weapon: "daggers", position: [52, 51] }), [enemy({ position: [51, 50], rear_exposed: false })]),
    );
    const actFlank = combatBehavior(ctxOf(gsFlank), gsFlank.enemies()[0]!);
    check(
      "daggers + not rear-exposed, facing-derived flank 1 step away -> defers (null)",
      actFlank === null,
      actFlank,
    );

    // Pass-2 fix M1a: the behind tile comes from the target's facing, not our
    // own approach angle (rear_exposed is facing-relative — the old heuristic
    // could steer daggers into the target's FRONT arc).
    const behindTile = flankingPosition([50, 50], [51, 50], [-1, 0]);
    check(
      "flankingPosition uses target facing (west-facing -> behind is east)",
      behindTile !== null && behindTile[0] === 52 && behindTile[1] === 50,
      behindTile,
    );
    check(
      "flankingPosition returns null when already standing behind",
      flankingPosition([52, 50], [51, 50], [-1, 0]) === null,
    );

    // Pass-2 fix M1b: the deferral TERMINATES. Pre-fix, the approach-angle
    // flank tile moved every time we did, so the one-step deferral re-armed
    // every tick and daggers orbited forever — 0 attack actions across entire
    // simulated rounds (docs/audit/pass2-phase2-observations.md). Simulate the
    // worst case (behind tile permanently 1 step away because the target spins
    // to face us each tick): within flankMaxDeferTicks + 1 consecutive ticks
    // the dagger must commit to a head-on attack.
    const gsOrbit = freshGameState();
    let attacked = false;
    for (let t = 0; t < DEFAULT_POLICY.flankMaxDeferTicks + 2; t++) {
      gsOrbit.applyTick(
        tickFrom(
          self({ weapon: "daggers", position: [52, 51] }),
          [enemy({ position: [51, 50], rear_exposed: false })],
          200 + t,
        ),
      );
      const a = combatBehavior({ gs: gsOrbit, directive: DEFAULT_DIRECTIVE, policy: DEFAULT_POLICY, tick: gsOrbit.tick }, gsOrbit.enemies()[0]!);
      if (a?.action === "attack") {
        attacked = true;
        break;
      }
    }
    check("dagger flank deferral terminates in an attack (no infinite orbit)", attacked);

    // The other half of the original comment's intent ("still attack if it's
    // the only option"): if the flanking tile isn't reachable, don't get
    // stuck doing nothing — attack anyway. Grid-edge placement pushes the
    // computed flank tile off the map.
    const gsNoFlank = freshGameState();
    gsNoFlank.applyTick(
      tickFrom(self({ weapon: "daggers", position: [99, 49] }), [enemy({ position: [99, 50], rear_exposed: false })]),
    );
    const actNoFlank = combatBehavior(ctxOf(gsNoFlank), gsNoFlank.enemies()[0]!);
    check(
      "daggers + not rear-exposed but flank tile unreachable -> attacks anyway",
      actNoFlank?.action === "attack",
      actNoFlank,
    );
  }

  console.log("\nDisengage HP gate is now tunable (Phase 4 fix 5)");
  {
    // Single hopeless-trade enemy (no gang-up ambiguity) at 90% HP: above the
    // default 0.6 gate, so trade math is never even consulted and we commit.
    // Regression test for: this gate used to be a raw `0.6` in controller.ts,
    // not read from EnginePolicy at all — every sibling threshold in the same
    // function (minTradeAdvantage, etc.) was already Tuner-adjustable; this one
    // wasn't.
    const ctl2 = new Controller();
    const tanky = () => {
      const g = freshGameState();
      g.applyTick(
        tickFrom(self({ hp: 144, max_hp: 160 }), [
          enemy({ bot_id: "juggernaut", hp: 2000, max_hp: 2000, position: [51, 50], can_attack: true }),
        ]),
      );
      return g;
    };

    ctl2.setPolicy(DEFAULT_POLICY);
    const withDefault = ctl2.decide(tanky());
    check(
      "90% HP vs a hopeless trade, default 0.6 gate -> commits (gate not reached)",
      withDefault.action === "attack",
      withDefault,
    );

    ctl2.setPolicy(mergePolicy(DEFAULT_POLICY, { disengageHpThreshold: 0.95 }));
    const withRaised = ctl2.decide(tanky());
    check(
      "same setup, Tuner raises the gate to 0.95 -> now disengages instead",
      withRaised.action !== "attack",
      withRaised,
    );
  }

  console.log("\nWeapon-matchup wired into targeting (Phase 4 fix 6)");
  {
    // Two otherwise-identical targets (same HP, same distance) differing only
    // in weapon: as daggers, bow is a hard counter (+2) and shield is a slight
    // disadvantage (-1) per matchups.ts. Regression test for: this matrix was
    // fully built but never consulted by target scoring at all.
    const gsMatchup = freshGameState();
    gsMatchup.applyTick(
      tickFrom(self({ weapon: "daggers", position: [50, 50] }), [
        enemy({ bot_id: "bowfoe", weapon: "bow", position: [55, 50] }),
        enemy({ bot_id: "shieldfoe", weapon: "shield", position: [50, 55] }),
      ]),
    );
    const picked = selectTarget({
      gs: gsMatchup,
      directive: DEFAULT_DIRECTIVE,
      policy: DEFAULT_POLICY,
      tick: gsMatchup.tick,
    });
    check(
      "daggers vs. equally-appealing bow/shield targets -> prefers the hard-countered bow",
      picked?.bot_id === "bowfoe",
      picked?.bot_id,
    );
  }

  console.log("\nAction economy: shove cooldown + gravity-well charges (pass-2 fixes C1/C2)");
  {
    // C2: shove is issued at most once per its 1.5s (15-tick) server cooldown.
    // Pre-fix, the cooling-window branch re-issued shove EVERY tick while our
    // weapon cooled with posture=aggressive — all but the first rejected
    // server-side, each rejection a tick spent standing point-blank.
    const ctl = new Controller();
    ctl.setPolicy({ ...DEFAULT_POLICY, posture: "aggressive" });
    const gShove = freshGameState();
    gShove.applyTick(tickFrom(self({ weapon_ready: false, dodge_cooldown: 5 }), [enemy({ position: [51, 50] })], 300));
    const s1 = ctl.decide(gShove);
    gShove.applyTick(tickFrom(self({ weapon_ready: false, dodge_cooldown: 5 }), [enemy({ position: [51, 50] })], 301));
    const s2 = ctl.decide(gShove);
    check("aggressive cooling window: first tick shoves", s1.action === "shove", s1);
    check("...next tick does NOT re-shove into the cooldown", s2.action !== "shove", s2);

    // C1: use_gravity_well requires a COLLECTED charge, not a pickup lying on
    // the ground. Staff + visible uncollected gravity pickup + clustered
    // enemies used to fire (rejected — no charge) at priority 6, preempting
    // combat entirely.
    const ctlG = new Controller();
    ctlG.setPolicy({ ...DEFAULT_POLICY });
    const gGw = freshGameState();
    gGw.setConfirmedAttackRange(5);
    const gwEntities: NearbyEntity[] = [
      enemy({ bot_id: "e1", position: [54, 50] }),
      enemy({ bot_id: "e2", position: [54, 52] }),
      pickup({ pickup_id: "gw1", pickup_type: "gravity_well", position: [52, 50] }),
    ];
    gGw.applyTick(tickFrom(self({ weapon: "staff" }), gwEntities, 400));
    const gwBefore = ctlG.decide(gGw);
    check("staff + ground gravity pickup (uncollected) -> does NOT cast gravity well", gwBefore.action !== "use_gravity_well", gwBefore);
    check("...fights instead (attack claims the tick)", gwBefore.action === "attack", gwBefore);

    // Collect the pickup (as the controller's choke point would record it)…
    gGw.noteIssuedAction({ type: "action", tick: 401, action: "use_item", item_id: "gw1" });
    gGw.applyTick(tickFrom(self({ weapon: "staff" }), gwEntities, 402));
    const gwAfter = ctlG.decide(gGw);
    check("…with a collected charge + cluster -> casts gravity well", gwAfter.action === "use_gravity_well", gwAfter);
    // The cast consumed the believed charge (decremented by decide()'s choke point).
    gGw.applyTick(tickFrom(self({ weapon: "staff" }), gwEntities, 403));
    const gwSpent = ctlG.decide(gGw);
    check("…and the spent charge is not re-cast next tick", gwSpent.action !== "use_gravity_well", gwSpent);
  }

  console.log("\nSpear brace-wait actually holds spacing (pass-2 fix C3)");
  {
    // Weapon ready, enemy braced in reach: must neither attack into the brace
    // NOR return null (pre-fix: null handed the tick to positionForCombat,
    // whose melee branch walked straight INTO the braced enemy).
    const ctl = new Controller();
    ctl.setPolicy(DEFAULT_POLICY);
    const gBrace = freshGameState();
    gBrace.setConfirmedAttackRange(2);
    gBrace.applyTick(
      tickFrom(self({ weapon: "spear", weapon_ready: true }), [enemy({ position: [52, 50], brace_ready: true })], 500),
    );
    const b1 = ctl.decide(gBrace);
    check("spear vs braced enemy -> does not attack into the brace", b1.action !== "attack", b1);
    if (b1.action === "move") {
      const landing: [number, number] = [50 + b1.direction[0], 50 + b1.direction[1]];
      check(
        "...holds/opens spacing (step does not close on the braced enemy)",
        chebyshev(landing, [52, 50]) >= chebyshev([50, 50], [52, 50]),
        landing,
      );
    } else {
      check("...emits a spacing action, not a fall-through approach", b1.action !== "move_to" || (b1 as { target_position: [number, number] }).target_position[0] < 52, b1);
    }
  }

  console.log("\nEnginePolicy (live LLM tuning)");
  {
    // mergePolicy clamps wild LLM values into safe ranges and bumps the version.
    const merged = mergePolicy(DEFAULT_POLICY, {
      dodgeEagerness: 9,
      kiteRangeBias: -99,
      mineCooldownTicks: 1,
      retreatTradeSensitivity: 99,
      disengageHpThreshold: -5,
      targetSwitchHysteresis: -20,
      targetMatchupWeight: 999,
    });
    check("mergePolicy clamps dodgeEagerness <= 1", merged.dodgeEagerness <= 1, merged.dodgeEagerness);
    check("mergePolicy clamps kiteRangeBias >= -3", merged.kiteRangeBias >= -3, merged.kiteRangeBias);
    check("mergePolicy bumps version", merged.version === DEFAULT_POLICY.version + 1, merged.version);
    // Phase 4 fix knobs: each must clamp into its documented range, not just accept any LLM value.
    check("mergePolicy clamps retreatTradeSensitivity <= 0.4", merged.retreatTradeSensitivity <= 0.4, merged.retreatTradeSensitivity);
    check("mergePolicy clamps disengageHpThreshold >= 0", merged.disengageHpThreshold >= 0, merged.disengageHpThreshold);
    check("mergePolicy clamps targetSwitchHysteresis >= 0", merged.targetSwitchHysteresis >= 0, merged.targetSwitchHysteresis);
    check("mergePolicy clamps targetMatchupWeight <= 40", merged.targetMatchupWeight <= 40, merged.targetMatchupWeight);
    // Pass-2 knobs: trade weight in targeting, dagger-flank orbit bound, kite-fire toggle.
    const p2 = mergePolicy(DEFAULT_POLICY, { targetTradeWeight: 999, flankMaxDeferTicks: -5, retreatFireWhileKiting: false });
    check("mergePolicy clamps targetTradeWeight <= 100", p2.targetTradeWeight <= 100, p2.targetTradeWeight);
    check("mergePolicy clamps flankMaxDeferTicks >= 0", p2.flankMaxDeferTicks >= 0, p2.flankMaxDeferTicks);
    check("mergePolicy carries retreatFireWhileKiting", p2.retreatFireWhileKiting === false, p2.retreatFireWhileKiting);
    check(
      "mergePolicy carries disengageUseSeparation",
      mergePolicy(DEFAULT_POLICY, { disengageUseSeparation: false }).disengageUseSeparation === false,
    );

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

  console.log("\nDirective/policy freshness (bot audit: version-reset + stale-round guards)");
  {
    const dir = (over: Partial<Directive>): Directive => ({ ...DEFAULT_DIRECTIVE, ...over });

    // Normal flow: strictly newer version accepted.
    check(
      "newer version accepted",
      shouldApplyDirective({ version: 5, ts: 1000 }, dir({ version: 6, ts: 1001, round: 3 }), 3),
    );
    // Duplicate / out-of-order delivery rejected.
    check(
      "same version + same ts rejected (duplicate)",
      !shouldApplyDirective({ version: 6, ts: 1001 }, dir({ version: 6, ts: 1001, round: 3 }), 3),
    );
    check(
      "older version + older ts rejected (out-of-order)",
      !shouldApplyDirective({ version: 6, ts: 2000 }, dir({ version: 4, ts: 1500, round: 3 }), 3),
    );
    // THE version-reset bug: a restarted Brain publishes version 1 while the
    // engine holds version 50 — must be accepted via the newer-ts path, or the
    // engine ignores every directive forever.
    check(
      "restarted brain (version reset, newer ts) accepted",
      shouldApplyDirective({ version: 50, ts: 1000 }, dir({ version: 1, ts: 5000, round: 3 }), 3),
    );
    check("isFresher: ts breaks a version regression", isFresher({ version: 50, ts: 1000 }, { version: 1, ts: 5000 }));
    // THE late-LLM-response bug: a tactic computed against round 3's snapshot
    // lands after round 4 started, with a higher version — must be rejected.
    check(
      "late cross-round directive rejected despite higher version",
      !shouldApplyDirective({ version: 6, ts: 1001 }, dir({ version: 7, ts: 9000, round: 3 }), 4),
    );
    // Round-agnostic directives (defaults / pre-round, round = -1) still land.
    check(
      "round=-1 directive accepted regardless of current round",
      shouldApplyDirective({ version: 6, ts: 1001 }, dir({ version: 7, ts: 9000, round: -1 }), 4),
    );

    // Consumer-side policy clamp: a raw KV write with wild values must be
    // clamped by the engine on read, preserving version/ts (same revision).
    const rawPolicy = {
      ...DEFAULT_POLICY,
      version: 7,
      ts: 12345,
      dodgeEagerness: 99,
      mineCooldownTicks: -50,
      aggression: 42,
      source: "rogue-writer",
    } as EnginePolicy;
    const sane = sanitizePolicy(rawPolicy);
    check("sanitizePolicy clamps dodgeEagerness to <=1", sane.dodgeEagerness <= 1, sane.dodgeEagerness);
    check("sanitizePolicy clamps mineCooldownTicks to >=5", sane.mineCooldownTicks >= 5, sane.mineCooldownTicks);
    check("sanitizePolicy clamps aggression to <=1", sane.aggression <= 1, sane.aggression);
    check("sanitizePolicy preserves version", sane.version === 7, sane.version);
    check("sanitizePolicy preserves ts", sane.ts === 12345, sane.ts);
    check("sanitizePolicy preserves source", sane.source === "rogue-writer", sane.source);
  }

  console.log("\nnormalizeStats: multiply-invalid LLM output (bot audit)");
  {
    // Sum 23 AND one stat at 15 at the same time — clamp then rebalance.
    const s = normalizeStats({ hp: 15, speed: 3, attack: 3, defense: 2 });
    check("multi-invalid: sums to 20", s.hp + s.speed + s.attack + s.defense === 20, s);
    check("multi-invalid: every stat in 1..10", Math.max(s.hp, s.speed, s.attack, s.defense) <= 10 && Math.min(s.hp, s.speed, s.attack, s.defense) >= 1, s);
    // NaN / missing / fractional values coerced, never NaN out.
    const n = normalizeStats({ hp: Number.NaN, speed: 7.7, attack: undefined as unknown as number, defense: 2 });
    check("NaN/fractional/missing: sums to 20", n.hp + n.speed + n.attack + n.defense === 20, n);
    check("NaN/fractional/missing: all integers", [n.hp, n.speed, n.attack, n.defense].every(Number.isInteger), n);
  }

  console.log("\nTokenBucket (bot audit: burst cap + monotonic refill)");
  {
    let clock = 0;
    const bucket = new TokenBucket(6, 20, () => clock);
    let taken = 0;
    for (let i = 0; i < 10; i++) if (bucket.tryTake()) taken += 1;
    check("burst capped at capacity (6), rapid calls can't exceed it", taken === 6, taken);
    clock += 100; // 100ms at 20/s -> 2 tokens
    check("refills from elapsed time (2 tokens after 100ms)", bucket.tryTake() && bucket.tryTake() && !bucket.tryTake());
    // A stalled/regressed clock must not corrupt the bucket (no free tokens,
    // no negative balance) and refill must resume once time advances again.
    clock -= 50;
    check("clock regression grants no tokens", !bucket.tryTake());
    clock += 100; // back past the last refill point
    check("refill resumes after the clock recovers", bucket.tryTake());
  }

  console.log("\nGameState round transition drops stale observations (bot audit)");
  {
    const gs = freshGameState();
    gs.applyTick(tickFrom(self(), [enemy({ bot_id: "ghost", position: [60, 60] })], 5900));
    check("enemy tracked before round end", gs.guessedEnemyPositions(30).length === 1);
    const rs: RoundStartMsg = {
      type: "round_start",
      round_number: 2,
      round_modifier: "",
      round_modifier_label: "",
      position: [10, 10],
      bots_in_round: 4,
      all_positions: {},
      safe_zone: { center: [50, 50], radius: 45, target_center: [50, 50], target_radius: 20 },
    };
    gs.applyRoundStart(rs);
    // If the server's tick counter resets per round, old entries had
    // tick=5900 > now and age-based expiry could NEVER reclaim them.
    check("round_start clears last-seen enemy memory", gs.guessedEnemyPositions(30).length === 0, gs.guessedEnemyPositions(30));
    check("round_start clears the entity cache", gs.enemies().length === 0);
  }

  console.log("\nArenaSocket server-frame whitelist (bot audit)");
  {
    check("'tick' is a valid server frame", isServerMessageType("tick"));
    check("'kick' is a valid server frame", isServerMessageType("kick"));
    // Spoofable EventEmitter internals / client-side lifecycle events must not
    // be emittable by a server frame.
    check("'close' frame is rejected (would spoof lifecycle)", !isServerMessageType("close"));
    check("'open' frame is rejected (would spoof lifecycle)", !isServerMessageType("open"));
    check("'newListener' frame is rejected (EventEmitter internal)", !isServerMessageType("newListener"));
  }

  console.log("\nMemoryBus KV TTL matches Redis EX semantics (bot audit)");
  {
    const bus = new MemoryBus({ kvTtlMs: 40 });
    await bus.setKV("k", { v: 1 });
    check("KV readable inside TTL", (await bus.getKV<{ v: number }>("k"))?.v === 1);
    await new Promise((r) => setTimeout(r, 60));
    check("KV expires after TTL (like Redis EX 300)", (await bus.getKV("k")) === null);
    await bus.close();
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

  console.log("\nDerived stats (matches the arena Stat Simulator exactly)");
  {
    // The simulator's published 5/5/5/5 sword build.
    const d = deriveStats({ hp: 5, speed: 5, attack: 5, defense: 5 });
    check("max_hp = 150", d.maxHp === 150, d.maxHp);
    check("speed = 5.5", d.speed === 5.5, d.speed);
    check("attack_mult = 1.5", d.attackMult === 1.5, d.attackMult);
    check("defense_red = 15%", Math.round(d.defenseRed * 100) === 15, d.defenseRed);
    check("effective_hp = 176", Math.round(d.effectiveHp) === 176, d.effectiveHp);
    check("defense_red caps at 30%", deriveStats({ hp: 5, speed: 5, attack: 5, defense: 10 }).defenseRed === 0.3);

    // The simulator's DPS table (sword base 23.18, cd 0.47), attacker attack 5.
    const base = 23.18, cd = 0.47;
    const rows: Array<[number, number, number, number]> = [
      // enemyDef, dmg/hit, dps, hits-to-kill(150)
      [0, 34.77, 73.98, 5],
      [5, 29.55, 62.88, 6],
      [10, 24.34, 51.79, 7],
    ];
    for (const [def, dmg, dps, htk] of rows) {
      const gotDmg = damagePerHit(base, 5, def);
      const gotDps = dpsInto(base, cd, 5, def);
      check(`def${def}: dmg/hit ${dmg}`, Math.abs(gotDmg - dmg) < 0.02, gotDmg.toFixed(2));
      check(`def${def}: dps ${dps}`, Math.abs(gotDps - dps) < 0.02, gotDps.toFixed(2));
      check(`def${def}: hits-to-kill ${htk}`, Math.ceil(150 / gotDmg) === htk, Math.ceil(150 / gotDmg));
    }

    // optimizeBuild: legal, budget-exact, honours floors, and beats neutral.
    const opt = optimizeBuild(WEAPONS.sword.damage, WEAPONS.sword.cooldown, { speedFloor: 5, defenseFloor: 2 });
    check("optimize sums to budget", opt.hp + opt.speed + opt.attack + opt.defense === 20, opt);
    check("optimize honours speed floor", opt.speed >= 5, opt);
    check("optimize honours defense floor", opt.defense >= 2, opt);
    check("optimize keeps defense LOW (weak stat)", opt.defense <= 3, opt);
    check(
      "optimize beats flat 5/5/5/5 fight power",
      fightPower(WEAPONS.sword.damage, WEAPONS.sword.cooldown, opt) >
        fightPower(WEAPONS.sword.damage, WEAPONS.sword.cooldown, { hp: 5, speed: 5, attack: 5, defense: 5 }),
      opt,
    );
  }

  console.log("\nWeapon matchups (Strategy tab) + counter-pick");
  {
    // The two hard counters the Strategy tab calls out explicitly.
    check("daggers hard-counter bow (+2)", matchupRating("daggers", "bow") === 2, matchupRating("daggers", "bow"));
    check("bow loses hard to daggers (-2)", matchupRating("bow", "daggers") === -2, matchupRating("bow", "daggers"));
    check("staff hard-counters shield (+2)", matchupRating("staff", "shield") === 2, matchupRating("staff", "shield"));
    check("mirror is even (0)", matchupRating("sword", "sword") === 0);
    check("unrated grapple pairing is even (0)", matchupRating("grapple", "bow") === 0);

    // Counter score vs a bow-heavy lobby: daggers strongly positive, bow neutral.
    const bowLobby = { bow: 3, shield: 1 } as Partial<Record<Weapon, number>>;
    check("daggers score high vs bow-heavy lobby", counterScore("daggers", bowLobby) > 1, counterScore("daggers", bowLobby));
    check("bow ~neutral in a bow mirror lobby", counterScore("bow", bowLobby) < counterScore("daggers", bowLobby));

    // rankCounterPicks flips an even base in favour of the counter weapon.
    const ranked = rankCounterPicks(["bow", "daggers"], bowLobby, () => 0.8);
    check("counter-pick beats equal-base weapon vs its counter", ranked[0]!.weapon === "daggers", ranked);

    // Deterministic fallback honours the lobby: a bow-heavy lobby -> daggers.
    const lo = chooseFallbackLoadout({ lobbyWeapons: { bow: 4 } });
    check("fallback counter-picks daggers vs 4 bows", lo.weapon === "daggers", lo.weapon);
    // With no lobby intel it falls back to the standalone meta pick.
    const loNoIntel = chooseFallbackLoadout({});
    check("fallback with no lobby is a legal weapon", ["sword", "bow", "daggers", "shield", "spear", "staff", "grapple"].includes(loNoIntel.weapon), loNoIntel.weapon);
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
    coopA.report({ ts: Date.now(), botId: "A", name: "A", weapon: "sword", pos, hp: 100, enemies: [{ id: "e1", hp: 80, pos }, { id: "e2", hp: 30, pos }] });
    // C mistakenly reports ally "A" as an enemy at 1 HP — the coalition must NOT
    // focus-fire it (guards against a friendly-classification race).
    coopC.report({ ts: Date.now(), botId: "C", name: "C", weapon: "bow", pos, hp: 100, enemies: [{ id: "A", hp: 1, pos }, { id: "e9", hp: 40, pos }] });
    await new Promise((r) => setTimeout(r, 10)); // flush pub/sub

    check("B learns allies A and C (friendlyIds)", coopB.friendlyIds().has("A") && coopB.friendlyIds().has("C"), [...coopB.friendlyIds()]);
    check("a bot does not list itself as a friendly", !coopA.friendlyIds().has("A"), [...coopA.friendlyIds()]);
    check("coalition focus = lowest-HP true enemy (e2 @30)", coopB.focus() === "e2", coopB.focus());
    check("coalition never focus-fires a friendly (skips A @1)", coopB.focus() !== "A", coopB.focus());
    check("pooled intel crosses the fog (B sees A-reported e2)", coopB.focus() === "e2", coopB.focus());

    // Non-aggression is permanent (pass-3 live fix): coalition reports are
    // tick-driven and stop between rounds / across reconnects, so the old 8s
    // TTL emptied friendly sets while teammates were still ours — observed
    // live as NeuralReaper killing GhostProtocol at endgame. Membership must
    // never expire within a process lifetime.
    check(
      "an ally stays friendly even after its reports stop (no TTL on membership)",
      (() => {
        // jump the clock a minute ahead — far past MEMBER_TTL_MS with no new
        // reports — and confirm the friendly set survives the recency purge.
        const realNow = Date.now;
        Date.now = () => realNow() + 60_000;
        try {
          const later = coopB.friendlyIds();
          return later.has("A") && later.has("C");
        } finally {
          Date.now = realNow;
        }
      })(),
    );
    // A teammate reported as an "enemy" by a confused ally must never enter
    // the shared pool — even for readers that HAVEN'T yet met the teammate
    // directly (C reported A@1hp above; A is a known member to B).
    check(
      "member ids never poison the pooled enemy list",
      coopB.focus() !== "A" && coopA.focus() !== "A",
      { b: coopB.focus(), a: coopA.focus() },
    );

    // Ally minefield sharing (pass-3 live fix): the server hides mines from
    // non-owners, so coalition partners walked blind into each other's mines
    // (two live coalition kills). Allies broadcast believed mine tiles; the
    // threat field treats them as hazards.
    coopA.report({ ts: Date.now(), botId: "A", name: "A", weapon: "sword", pos, hp: 100, enemies: [], mines: [[60, 60], [61, 60]] });
    await new Promise((r) => setTimeout(r, 10));
    check(
      "ally mine tiles reach the coalition (B sees A's mines)",
      coopB.friendlyMines().some(([x, y]) => x === 60 && y === 60) && coopB.friendlyMines().length === 2,
      coopB.friendlyMines(),
    );
    coopA.report({ ts: Date.now(), botId: "A", name: "A", weapon: "sword", pos, hp: 100, enemies: [], mines: [] });
    await new Promise((r) => setTimeout(r, 10));
    check("an ally's empty mine list clears its previous tiles", coopB.friendlyMines().length === 0, coopB.friendlyMines());

    // Own-mine bookkeeping + threat-field integration.
    const gsM = freshGameState();
    gsM.applyTick(tickFrom(self({ position: [55, 55] }), []));
    gsM.noteIssuedAction({ type: "action", tick: 100, action: "place_mine" });
    check(
      "issued place_mine is remembered at our position",
      gsM.ownMinePositions().length === 1 && gsM.ownMinePositions()[0]![0] === 55,
      gsM.ownMinePositions(),
    );
    const gsT = freshGameState();
    gsT.applyTick(tickFrom(self(), []));
    const calm = gsT.threatField().danger(60, 60);
    gsT.setAllyMines([[60, 60] as [number, number]]);
    const mined = gsT.threatField().danger(60, 60);
    check("ally mine tile reads as a hazard in the threat field", mined >= calm + 50, { calm, mined });
    check("ally mine tile hard-blocks safe stepping (not just discouraged)", !gsT.isSafeStep(60, 60) && !gsT.isSafeStep(61, 60));
    gsT.applyRoundStart({ type: "round_start", round_number: 99, round_modifier: "", bots_in_round: 4 } as RoundStartMsg);
    check("round transition clears ally-mine beliefs", gsT.threatField().danger(60, 60) < mined, gsT.threatField().danger(60, 60));

    // Coalition rides the global channel, not a per-bot scope.
    check("coalition uses the global coop channel", Channels.coop === "arena:coop", Channels.coop);
    coopA.stop();
    coopB.stop();
    coopC.stop();
    await bus.close();
  }

  console.log("\nloadout agent consumes opponent profiles");
  {
    const req: LoadoutRequest = {
      ts: Date.now(),
      round: 3,
      context: {
        ts: Date.now(),
        round: 3,
        roundModifier: "",
        ourStats: null,
        arenaBotsConnected: 6,
        fleetIndex: 1,
        fleetSize: 3,
        lobbyWeapons: {},
        constraints: { statBudget: 20, statMin: 1, statMax: 10, availableWeapons: [] },
      },
      fallback: chooseFallbackLoadout({}),
    };
    const agent = new LoadoutAgent();
    // userPrompt is protected — reach in for the assertion only.
    const promptOf = (input: LoadoutAgentInput): string =>
      (agent as unknown as { userPrompt(i: LoadoutAgentInput): string }).userPrompt(input);
    const baseMeta = {
      leaderboardTop: [],
      weaponPopularity: {},
      weaponMeta: [],
      ourStats: null,
      arenaBotsConnected: 6,
      insights: { ...DEFAULT_INSIGHTS },
      fleetIndex: 1 as number | null,
      fleetSize: 3,
      weaponWinRates: { daggers: { wins: 0, played: 4 }, staff: { wins: 1, played: 1 } } as Partial<
        Record<Weapon, { wins: number; played: number }>
      >,
    };
    const withProfile = promptOf({
      request: req,
      meta: {
        ...baseMeta,
        opponentProfiles: [
          { name: "Lancer", elo: 1220, primaryWeapon: "bow", killsVsUs: 3, deathsVsUs: 1, roundsFaced: 4 },
        ],
      },
    });
    check(
      "prompt includes matched opponent profile (name + weapon + ledger)",
      withProfile.includes('"known_opponents"') &&
        withProfile.includes("Lancer") &&
        withProfile.includes('"primaryWeapon":"bow"') &&
        withProfile.includes('"killsVsUs":3'),
    );
    const withoutProfile = promptOf({ request: req, meta: { ...baseMeta, opponentProfiles: [] } });
    check("no profiles -> known_opponents is null (no phantom data)", withoutProfile.includes('"known_opponents":null'));
    check(
      "system prompt instructs counter-picking known opponents",
      (agent as unknown as { systemPrompt(): string }).systemPrompt().includes("known_opponents"),
    );

    // Fleet diversity + learned weapon evidence (win-rate pass follow-up):
    // three bots drafting from identical inputs all opened daggers every
    // round; the prompt now carries fleet position and OUR per-weapon record.
    check(
      "prompt carries fleet position and learned weapon history",
      withProfile.includes('"fleet_index":1') &&
        withProfile.includes('"fleet_size":3') &&
        withProfile.includes('"daggers":{"wins":0,"played":4}'),
    );
    check(
      "system prompt instructs fleet archetype diversity from learnings",
      (agent as unknown as { systemPrompt(): string }).systemPrompt().includes("FLEET DIVERSITY"),
    );

    // Deterministic fallback rotates the fleet across the top-ranked picks —
    // never three copies of one weapon.
    const picks = [0, 1, 2].map((i) => chooseFallbackLoadout({ fleetIndex: i }).weapon);
    check("fallback fleet drafts three distinct weapons", new Set(picks).size === 3, picks);
    check(
      "lone bot (no fleetIndex) keeps the old best pick",
      chooseFallbackLoadout({}).weapon === picks[0],
      { solo: chooseFallbackLoadout({}).weapon, picks },
    );
    // Server autopilot fleet rule: fleets never hand the server a hunting
    // fallback (autopilot attacks the nearest bot, teammates included).
    const fleetFallbacks = [0, 1, 2].map((i) => chooseFallbackLoadout({ fleetIndex: i }).fallback_behavior);
    check(
      "fleet fallback behaviors are never hunter/aggressive",
      fleetFallbacks.every((f) => f !== "hunter" && f !== "aggressive"),
      fleetFallbacks,
    );
    check(
      "loadout system prompt carries the autopilot fleet rule",
      (agent as unknown as { systemPrompt(): string }).systemPrompt().includes("never hunter"),
    );
  }

  console.log("\nbounty-aware targeting (win-rate pass)");
  {
    const ctxOf = (g: GameState) => ({ gs: g, directive: DEFAULT_DIRECTIVE, policy: DEFAULT_POLICY, tick: g.tick });

    // Two otherwise-identical enemies; only B carries a bounty -> B wins.
    const gsB = freshGameState();
    gsB.setBounties([{ botId: "b" }]);
    gsB.applyTick(
      tickFrom(self(), [
        enemy({ bot_id: "a", position: [55, 50] }),
        enemy({ bot_id: "b", position: [55, 50] }),
      ]),
    );
    const pickedBounty = selectTarget(ctxOf(gsB));
    check("bounty carrier outranks an identical non-carrier", pickedBounty?.bot_id === "b", pickedBounty?.bot_id);

    // Name fallback: the bounty API sometimes omits bot_id.
    const gsN = freshGameState();
    gsN.setBounties([{ name: "Bar" }]);
    check("isBountyTarget matches by name when id is absent", gsN.isBountyTarget("whatever", "Bar"));
    check("no phantom bounty without id or name match", !gsN.isBountyTarget("a", "Foo"));

    // Board refresh replaces, never accumulates.
    gsN.setBounties([{ botId: "c" }]);
    check("setBounties replaces the previous board", !gsN.isBountyTarget("whatever", "Bar") && gsN.isBountyTarget("c"));

    // New knob rides the standard clamp table.
    const clamped = mergePolicy(DEFAULT_POLICY, { targetBountyWeight: 9999 });
    check("targetBountyWeight clamped to [0,100]", clamped.targetBountyWeight === 100, clamped.targetBountyWeight);
    check("targetBountyWeight default is 25", DEFAULT_POLICY.targetBountyWeight === 25);
  }

  console.log("\ngank anticipation (win-rate pass): closing third bot sours the trade early");
  {
    const ctxOf = (g: GameState, policy = DEFAULT_POLICY) => ({ gs: g, directive: DEFAULT_DIRECTIVE, policy, tick: g.tick });

    // Scenario A: clean favorable 1v1 (weak adjacent target).
    const solo = freshGameState();
    solo.applyTick(tickFrom(self(), [enemy({ bot_id: "t", hp: 30, max_hp: 160, position: [51, 50] })], 100));
    const target = solo.enemies()[0]!;
    const advSolo = tradeAdvantage(ctxOf(solo), target);
    check("favorable 1v1 reads positive", advSolo > 0, advSolo);

    // Scenario B: same 1v1 plus a third bot at 8 tiles, closing 1 tile/tick
    // (two ticks establish its velocity estimate). It's outside the old 5-tile
    // band, so pre-fix it moved the number by exactly 0.
    const ganked = freshGameState();
    ganked.applyTick(
      tickFrom(self(), [
        enemy({ bot_id: "t", hp: 30, max_hp: 160, position: [51, 50] }),
        enemy({ bot_id: "g", position: [60, 50] }),
      ], 100),
    );
    ganked.applyTick(
      tickFrom(self(), [
        enemy({ bot_id: "t", hp: 30, max_hp: 160, position: [51, 50] }),
        enemy({ bot_id: "g", position: [58, 50] }),
      ], 102),
    );
    const targetG = ganked.enemies().find((e) => e.bot_id === "t")!;
    const advGank = tradeAdvantage(ctxOf(ganked), targetG);
    check("closing ganker at 8 tiles sours the trade vs clean 1v1", advGank < advSolo, { advSolo, advGank });

    // Scenario C: same third bot but stationary — no anticipation charge.
    const idle = freshGameState();
    idle.applyTick(
      tickFrom(self(), [
        enemy({ bot_id: "t", hp: 30, max_hp: 160, position: [51, 50] }),
        enemy({ bot_id: "g", position: [58, 50] }),
      ], 100),
    );
    idle.applyTick(
      tickFrom(self(), [
        enemy({ bot_id: "t", hp: 30, max_hp: 160, position: [51, 50] }),
        enemy({ bot_id: "g", position: [58, 50] }),
      ], 102),
    );
    const targetI = idle.enemies().find((e) => e.bot_id === "t")!;
    const advIdle = tradeAdvantage(ctxOf(idle), targetI);
    check("stationary distant bot does not charge the trade", Math.abs(advIdle - advSolo) < 1e-9, { advSolo, advIdle });

    // Weight 0 restores the old in-band-only behavior exactly.
    const off = mergePolicy(DEFAULT_POLICY, { gankApproachWeight: 0 });
    const advOff = tradeAdvantage(ctxOf(ganked, off), targetG);
    check("gankApproachWeight=0 restores pre-fix behavior", Math.abs(advOff - advSolo) < 1e-9, { advSolo, advOff });

    // Clamps.
    const clamped = mergePolicy(DEFAULT_POLICY, { gankRadius: 999, gankApproachWeight: 42 });
    check("gank knobs clamped (radius<=16, weight<=1)", clamped.gankRadius === 16 && clamped.gankApproachWeight === 1);
  }

  console.log("\nzone-endgame posture (win-rate pass; default-OFF after live A/B, tested with knob on)");
  {
    // Live A/B measured the posture harmful at default-on (0/18 wins vs 7/22
    // with it off), so DEFAULT_POLICY ships endgameZoneRadius=0. The code
    // path stays Tuner-reachable — these tests pin the knob on explicitly.
    const ENDGAME_ON = mergePolicy(DEFAULT_POLICY, { endgameZoneRadius: 12 });
    // Tiny (10-tile) settled zone, bot at center so the zone-safety rungs stay
    // quiet; a marginal fight vs a full-HP shield with a second attacker in
    // range — exactly the endgame overextension that used to be auto-committed.
    const endgameSelf = (over: Partial<SelfState> = {}) =>
      self({
        zone_radius: 10,
        zone_target_radius: 10,
        distance_to_zone_edge: 10,
        ...over,
      });
    // Second attacker inside the 5-tile trade band but LOS-blocked so target
    // selection deterministically stays on the adjacent tank (the trade math
    // counts in-band attackers regardless of LOS).
    const crowd = [
      enemy({ bot_id: "tank", weapon: "shield", hp: 160, max_hp: 160, position: [51, 50] }),
      enemy({ bot_id: "second", position: [54, 50], has_los: false }),
    ];

    const ctlE = new Controller();
    ctlE.onRoundStart();
    ctlE.setPolicy(ENDGAME_ON);
    const gsEnd = freshGameState();
    gsEnd.applyTick(tickFrom(endgameSelf(), crowd));
    const aEnd = ctlE.decide(gsEnd);
    check(
      "endgame + 2 enemies + bad trade -> disengages even at full HP",
      aEnd.action !== "attack",
      aEnd,
    );

    // Identical fight in a big (40-tile) zone -> healthy bot still commits.
    const ctlBig = new Controller();
    ctlBig.onRoundStart();
    const gsBig = freshGameState();
    gsBig.applyTick(tickFrom(self({ zone_radius: 40, zone_target_radius: 40, distance_to_zone_edge: 25 }), crowd));
    const aBig = ctlBig.decide(gsBig);
    check("same fight in a big zone -> commits while healthy (pre-existing behavior)", aBig.action === "attack", aBig);

    // Endgame FINAL 1v1: no extra caution — passivity just splits zone damage.
    const ctl1v1 = new Controller();
    ctl1v1.onRoundStart();
    ctl1v1.setPolicy(ENDGAME_ON);
    const gs1v1 = freshGameState();
    gs1v1.applyTick(tickFrom(endgameSelf(), [crowd[0]!]));
    const a1v1 = ctl1v1.decide(gs1v1);
    check("endgame final 1v1 -> still fights", a1v1.action === "attack", a1v1);

    // endgameZoneRadius=0 disables the whole posture.
    const ctlOff = new Controller();
    ctlOff.onRoundStart();
    ctlOff.setPolicy(mergePolicy(DEFAULT_POLICY, { endgameZoneRadius: 0 }));
    const gsOff = freshGameState();
    gsOff.applyTick(tickFrom(endgameSelf(), crowd));
    const aOff = ctlOff.decide(gsOff);
    check("endgameZoneRadius=0 restores commit-while-healthy", aOff.action === "attack", aOff);

    // Idle center-hold: endgame, nothing to fight, bot 8 tiles off-center ->
    // drifts to the zone center instead of roaming outward.
    const ctlHold = new Controller();
    ctlHold.onRoundStart();
    ctlHold.setPolicy(ENDGAME_ON);
    const gsHold = freshGameState();
    gsHold.applyTick(
      tickFrom(endgameSelf({ position: [58, 50], distance_to_zone_edge: 2.2 }), []),
    );
    // distance_to_zone_edge above the hard margin is still inside zoneEdgeMargin,
    // so pick a settled zone instead: no shrink -> no drift rung; then hold_ground.
    const aHold = ctlHold.decide(gsHold);
    check(
      "endgame idle -> holds the zone center",
      aHold.action === "move_to" && aHold.target_position[0] === 50 && aHold.target_position[1] === 50,
      aHold,
    );

    // Clamps for the three new knobs.
    const c = mergePolicy(DEFAULT_POLICY, { endgameZoneRadius: 999, endgameTradeCaution: 9, endgameCenterHoldFraction: 9 });
    check(
      "endgame knobs clamped (radius<=40, caution<=0.6, holdFraction<=0.9)",
      c.endgameZoneRadius === 40 && c.endgameTradeCaution === 0.6 && c.endgameCenterHoldFraction === 0.9,
    );
  }

  console.log("\ncharged-attack punish (win-rate pass): shove interrupts an adjacent windup");
  {
    const ctxOf = (g: GameState, policy = DEFAULT_POLICY) => ({ gs: g, directive: DEFAULT_DIRECTIVE, policy, tick: g.tick });
    const charging = (over: Partial<NearbyBot> = {}) =>
      enemy({ bot_id: "archer", weapon: "bow", hp: 120, max_hp: 160, position: [51, 50], charged_shot_ready: true, ...over });

    // Adjacent enemy with a ready charged shot -> shove denies it (even though
    // our own weapon is ready and an attack was available).
    const gsSh = freshGameState();
    gsSh.applyTick(tickFrom(self(), [charging()]));
    const aSh = combatBehavior(ctxOf(gsSh), gsSh.enemies()[0]!);
    check("adjacent charged_shot_ready -> shove interrupt", aSh?.action === "shove", aSh);

    // Near-dead charger -> a kill beats an interrupt.
    const gsKill = freshGameState();
    gsKill.applyTick(tickFrom(self(), [charging({ hp: 10 })]));
    const aKill = combatBehavior(ctxOf(gsKill), gsKill.enemies()[0]!);
    check("near-dead charger -> attack to kill instead of shoving", aKill?.action === "attack", aKill);

    // bow_charge_level >= 2 telegraphs the same interrupt.
    const gsLvl = freshGameState();
    gsLvl.applyTick(tickFrom(self(), [charging({ charged_shot_ready: false, bow_charge_level: 2 })]));
    const aLvl = combatBehavior(ctxOf(gsLvl), gsLvl.enemies()[0]!);
    check("bow_charge_level>=2 -> shove interrupt", aLvl?.action === "shove", aLvl);

    // Toggle off restores plain attack.
    const off = mergePolicy(DEFAULT_POLICY, { shoveInterruptCharged: false });
    const gsOff = freshGameState();
    gsOff.applyTick(tickFrom(self(), [charging()]));
    const aOff = combatBehavior(ctxOf(gsOff, off), gsOff.enemies()[0]!);
    check("shoveInterruptCharged=false -> attacks as before", aOff?.action === "attack", aOff);

    // Respects the server's 1.5s shove cooldown (second interrupt inside the
    // window falls through to a normal attack, not a wasted rejected shove).
    const gsCd = freshGameState();
    gsCd.applyTick(tickFrom(self(), [charging()], 100));
    const first = combatBehavior(ctxOf(gsCd), gsCd.enemies()[0]!);
    gsCd.noteIssuedAction({ type: "action", tick: 100, action: "shove", target: "archer" });
    gsCd.applyTick(tickFrom(self(), [charging()], 105));
    const second = combatBehavior(ctxOf(gsCd), gsCd.enemies()[0]!);
    check(
      "shove-interrupt respects the 1.5s shove cooldown",
      first?.action === "shove" && second?.action === "attack",
      { first, second },
    );
  }

  console.log("\nhazard pulse awareness (deep dive): dormant hazards are crossable, not campable");
  {
    const hazard = (active: boolean | undefined, pos: [number, number]) =>
      ({ type: "hazard", position: pos, radius: 1, active }) as unknown as NearbyEntity;

    const gsH = freshGameState();
    gsH.applyTick(tickFrom(self(), [hazard(true, [52, 50]), hazard(false, [48, 50])]));
    check("active hazard blocks safe stepping", !gsH.isSafeStep(52, 50) && !gsH.isSafeStep(53, 50));
    check("dormant hazard is crossable (off-phase)", gsH.isSafeStep(48, 50), gsH.hazardTiles());
    check(
      "dormant hazard keeps a residual threat cost (don't camp it)",
      gsH.threatField().danger(48, 50) > 0 && gsH.threatField().danger(48, 50) < 50,
      gsH.threatField().danger(48, 50),
    );
    check(
      "hazard with no active field stays lethal (unknown = dangerous)",
      (() => {
        const gsU = freshGameState();
        gsU.applyTick(tickFrom(self(), [hazard(undefined, [52, 50])]));
        return !gsU.isSafeStep(52, 50);
      })(),
    );
  }

  console.log("\nzone-escape grapple (deep dive): anchor-pull back in instead of walking");
  {
    const stranded = (over: Partial<SelfState> = {}) =>
      self({
        in_safe_zone: false,
        distance_to_zone_edge: 8,
        zone_center: [50, 50],
        position: [70, 50],
        grapple_charges: 1,
        grapple_cooldown: 0,
        ...over,
      });
    const ctxOf = (g: GameState, policy = DEFAULT_POLICY) => ({ gs: g, directive: DEFAULT_DIRECTIVE, policy, tick: g.tick });

    const gsZ = freshGameState();
    gsZ.applyTick(tickFrom(stranded(), []));
    const aZ = survivalBehavior(ctxOf(gsZ));
    check(
      "deep outside + charge ready -> grapples toward the zone",
      aZ?.action === "grapple" && aZ.target_position !== undefined && aZ.target_position[0] < 70,
      aZ,
    );

    const gsNoCharge = freshGameState();
    gsNoCharge.applyTick(tickFrom(stranded({ grapple_charges: 0 }), []));
    const aNC = survivalBehavior(ctxOf(gsNoCharge));
    check("no charge -> walks back as before", aNC?.action === "move" || aNC?.action === "move_to", aNC);

    const gsNear = freshGameState();
    gsNear.applyTick(tickFrom(stranded({ distance_to_zone_edge: 2 }), []));
    const aNear = survivalBehavior(ctxOf(gsNear));
    check("just outside the edge -> saves the charge, walks", aNear?.action !== "grapple", aNear);

    const off = mergePolicy(DEFAULT_POLICY, { grappleZoneEscape: false });
    const gsOff = freshGameState();
    gsOff.applyTick(tickFrom(stranded(), []));
    const aOff = survivalBehavior(ctxOf(gsOff, off));
    check("grappleZoneEscape=false restores walking", aOff?.action !== "grapple", aOff);
  }

  console.log("\nfriendly splash guard: sword cleave / staff AoE never clip coalition allies");
  {
    const ctxOf = (g: GameState, policy = DEFAULT_POLICY) => ({ gs: g, directive: DEFAULT_DIRECTIVE, policy, tick: g.tick });

    // Sword bot, enemy adjacent, ALLY also adjacent -> no swing (cleave would
    // clip the ally); it repositions instead.
    const gsC = freshGameState();
    gsC.applyTick(
      tickFrom(self({ weapon: "sword" }), [
        enemy({ bot_id: "foe", position: [51, 50] }),
        enemy({ bot_id: "ally", position: [50, 51] }),
      ]),
    );
    gsC.setFriendlies(new Set(["ally"]));
    const foe = gsC.enemies().find((e) => e.bot_id === "foe")!;
    const aC = combatBehavior(ctxOf(gsC), foe);
    check("sword + ally in the arc -> repositions instead of cleaving", aC?.action !== "attack", aC);

    // Ally hugging the TARGET (2 tiles from us) also blocks the swing.
    const gsT2 = freshGameState();
    gsT2.applyTick(
      tickFrom(self({ weapon: "sword" }), [
        enemy({ bot_id: "foe", position: [51, 50] }),
        enemy({ bot_id: "ally", position: [52, 50] }),
      ]),
    );
    gsT2.setFriendlies(new Set(["ally"]));
    const aT2 = combatBehavior(ctxOf(gsT2), gsT2.enemies().find((e) => e.bot_id === "foe")!);
    check("sword + ally hugging the target -> holds the swing", aT2?.action !== "attack", aT2);

    // No ally around -> swings exactly as before.
    const gsFree = freshGameState();
    gsFree.applyTick(tickFrom(self({ weapon: "sword" }), [enemy({ bot_id: "foe", position: [51, 50] })]));
    const aFree = combatBehavior(ctxOf(gsFree), gsFree.enemies()[0]!);
    check("sword with no ally around -> attacks as before", aFree?.action === "attack", aFree);

    // Toggle restores the old behavior even with an ally adjacent.
    const off = mergePolicy(DEFAULT_POLICY, { friendlySplashGuard: false });
    const aOff = combatBehavior(ctxOf(gsC, off), foe);
    check("friendlySplashGuard=false restores cleaving", aOff?.action === "attack", aOff);

    // Staff: AoE tile re-aims off an ally-adjacent cluster centroid.
    const gsS = freshGameState();
    gsS.applyTick(
      tickFrom(self({ weapon: "staff" }), [
        enemy({ bot_id: "foe", position: [54, 50] }),
        enemy({ bot_id: "ally", position: [54, 51] }),
      ]),
    );
    gsS.setFriendlies(new Set(["ally"]));
    const aS = combatBehavior(ctxOf(gsS), gsS.enemies().find((e) => e.bot_id === "foe")!);
    check(
      "staff never drops AoE on an ally tile (re-aims or repositions)",
      aS === null || aS.action !== "attack" || !("target_position" in aS) || aS.target_position === undefined ||
        Math.max(Math.abs(aS.target_position[0] - 54), Math.abs(aS.target_position[1] - 51)) > 1,
      aS,
    );
  }

  console.log("\nfire-lane + retreat-mine discipline (coalition)");
  {
    const ctxOf = (g: GameState, policy = DEFAULT_POLICY) => ({ gs: g, directive: DEFAULT_DIRECTIVE, policy, tick: g.tick });

    // Bow bot, target at 6 tiles, ally standing ON the line at 3 tiles -> no shot.
    const gsL = freshGameState();
    gsL.setConfirmedAttackRange(8); // freshGameState pins melee range 1
    gsL.applyTick(
      tickFrom(self({ weapon: "bow" }), [
        enemy({ bot_id: "foe", position: [56, 50], attack_range: 8 }),
        enemy({ bot_id: "ally", position: [53, 50] }),
      ]),
    );
    gsL.setFriendlies(new Set(["ally"]));
    const foeL = gsL.enemies().find((e) => e.bot_id === "foe")!;
    const aL = combatBehavior(ctxOf(gsL), foeL);
    check("bow never shoots through an ally in the fire lane", aL?.action !== "attack", aL);

    // Ally clearly off the line -> shot goes out unchanged.
    const gsClear = freshGameState();
    gsClear.setConfirmedAttackRange(8);
    gsClear.applyTick(
      tickFrom(self({ weapon: "bow" }), [
        enemy({ bot_id: "foe", position: [56, 50], attack_range: 8 }),
        enemy({ bot_id: "ally", position: [53, 46] }),
      ]),
    );
    gsClear.setFriendlies(new Set(["ally"]));
    const aClear = combatBehavior(ctxOf(gsClear), gsClear.enemies().find((e) => e.bot_id === "foe")!);
    check("bow with a clear lane fires as before", aClear?.action === "attack", aClear);

    // Grapple yank drags the target's body along the pull line — blocked when
    // an ally stands on it (two live kills by the grapple slot).
    const gsG = freshGameState();
    gsG.applyTick(
      tickFrom(self({ weapon: "grapple", grapple_charges: 2, grapple_cooldown: 0 }), [
        enemy({ bot_id: "foe", position: [58, 50] }),
        enemy({ bot_id: "ally", position: [54, 50] }),
      ]),
    );
    gsG.setFriendlies(new Set(["ally"]));
    const aG = combatBehavior(ctxOf(gsG), gsG.enemies().find((e) => e.bot_id === "foe")!);
    check(
      "grapple never yanks a target through an ally on the pull line",
      !(aG?.action === "grapple" && aG.target === "foe"),
      aG,
    );
    const gsGClear = freshGameState();
    gsGClear.applyTick(
      tickFrom(self({ weapon: "grapple", grapple_charges: 2, grapple_cooldown: 0 }), [
        enemy({ bot_id: "foe", position: [58, 50] }),
        enemy({ bot_id: "ally", position: [54, 45] }),
      ]),
    );
    gsGClear.setFriendlies(new Set(["ally"]));
    const aGC = combatBehavior(ctxOf(gsGClear), gsGClear.enemies().find((e) => e.bot_id === "foe")!);
    check("grapple with a clear pull line yanks as before", aGC?.action === "grapple" && aGC.target === "foe", aGC);

    // move_to paths are server-pathed and blind to invisible ally mines —
    // knownMineOnPath flags a straight path crossing one.
    const gsP = freshGameState();
    gsP.applyTick(tickFrom(self(), []));
    gsP.setAllyMines([[55, 50] as [number, number]]);
    check("straight path over an ally mine is flagged", gsP.knownMineOnPath([60, 50]));
    check("path well clear of the mine is not flagged", !gsP.knownMineOnPath([50, 60]));
    check("believed own mines no longer expire (round-lifetime)", (() => {
      const g = freshGameState();
      g.applyTick(tickFrom(self({ position: [40, 40] }), []));
      g.noteIssuedAction({ type: "action", tick: 100, action: "place_mine" });
      const realNow = Date.now;
      Date.now = () => realNow() + 200_000;
      try {
        return g.ownMinePositions().length === 1;
      } finally {
        Date.now = realNow;
      }
    })());

    // Retreat mine suppressed when an ally trails within 6 tiles.
    const ctlM = new Controller();
    ctlM.onRoundStart();
    const gsMine = freshGameState();
    gsMine.applyTick(
      tickFrom(self({ hp: 20, max_hp: 160 }), [
        enemy({ bot_id: "chaser", position: [48, 50] }),
        enemy({ bot_id: "ally", position: [52, 50] }),
      ]),
    );
    gsMine.setFriendlies(new Set(["ally"]));
    const aMine = ctlM.decide(gsMine);
    check("no mine seeded in a shared retreat corridor (ally within 6)", aMine.action !== "place_mine", aMine);
  }

  console.log("\ngrapple yank-range threat modeling (deep dive 2)");
  {
    // A grapple wielder at 9 tiles: profile range ~5 says 'safe', the 12-tile
    // yank says otherwise. Our tile must read meaningfully more dangerous than
    // the same layout with a sword enemy (whose reach really is short).
    const gsY = freshGameState();
    gsY.applyTick(tickFrom(self(), [enemy({ bot_id: "hook", weapon: "grapple", position: [59, 50], attack_range: 0 })]));
    const gsS = freshGameState();
    gsS.applyTick(tickFrom(self(), [enemy({ bot_id: "swd", weapon: "sword", position: [59, 50], attack_range: 0 })]));
    const yank = gsY.threatField().danger(50, 50);
    const sword = gsS.threatField().danger(50, 50);
    check("grapple wielder at 9 tiles reads far more dangerous than sword", yank > sword * 3, { yank, sword });
    // Beyond yank range the band ends.
    const gsFar = freshGameState();
    gsFar.applyTick(tickFrom(self(), [enemy({ bot_id: "hook", weapon: "grapple", position: [64, 50], attack_range: 0 })]));
    check(
      "beyond 12 tiles the yank band is gone",
      Math.abs(gsFar.threatField().danger(50, 50) - gsS.threatField().danger(50, 50)) < 5,
      gsFar.threatField().danger(50, 50),
    );
  }

  console.log("\nspectator intel → engine (fog-free mines / hunters / aggro graph)");
  {
    // Armed enemy mine (invisible in bot fog) becomes a first-class hazard.
    const gsSpec = freshGameState();
    gsSpec.applyTick(tickFrom(self(), []));
    gsSpec.setGlobalIntel({ mines: [{ pos: [53, 50], ownerId: "villain" }], bots: [] });
    check("spectator enemy mine rides hazardTiles", gsSpec.hazardTiles().some(([c, r]) => c === 53 && r === 50));
    check("stepping next to a spectator mine is unsafe", !gsSpec.isSafeStep(52, 50));
    check("move_to path over a spectator mine is flagged", gsSpec.knownMineOnPath([58, 50]));

    // Feed gone/stale/knob off -> setGlobalIntel(null) restores fog-only play.
    gsSpec.setGlobalIntel(null);
    check(
      "null intel clears spectator hazards entirely",
      !gsSpec.hazardTiles().some(([c, r]) => c === 53 && r === 50) && !gsSpec.knownMineOnPath([58, 50]),
    );

    // Friendly-owned mines already arrive via the coop broadcast (allyMines) —
    // the spectator copy is dropped so the threat field never double-counts.
    const gsF = freshGameState();
    gsF.applyTick(tickFrom(self(), []));
    gsF.setFriendlies(new Set(["allyBot"]));
    gsF.setGlobalIntel({ mines: [{ pos: [53, 50], ownerId: "allyBot" }], bots: [] });
    check("friendly-owned spectator mines are filtered out", !gsF.hazardTiles().some(([c, r]) => c === 53 && r === 50));

    // Out-of-fog hunter (server-confirmed target = us) worsens the trade read.
    const mkDuel = (): GameState => {
      const g = freshGameState();
      g.applyTick(tickFrom(self(), [enemy({ bot_id: "duel", position: [51, 50], hp: 80 })]));
      return g;
    };
    const gNo = mkDuel();
    const dNo = tradeAdvantage({ gs: gNo, directive: DEFAULT_DIRECTIVE, policy: DEFAULT_POLICY, tick: 100 }, gNo.enemies()[0]!);
    const gYes = mkDuel();
    gYes.setGlobalIntel({ mines: [], bots: [{ id: "third", weapon: "sword", pos: [60, 50], hp: 160, targetId: "me" }] });
    const dYes = tradeAdvantage({ gs: gYes, directive: DEFAULT_DIRECTIVE, policy: DEFAULT_POLICY, tick: 100 }, gYes.enemies()[0]!);
    check("confirmed out-of-fog hunter lowers tradeAdvantage", dYes < dNo, { dNo, dYes });

    const gOther = mkDuel();
    gOther.setGlobalIntel({ mines: [], bots: [{ id: "third", weapon: "sword", pos: [60, 50], hp: 160, targetId: "someone-else" }] });
    const dOther = tradeAdvantage({ gs: gOther, directive: DEFAULT_DIRECTIVE, policy: DEFAULT_POLICY, tick: 100 }, gOther.enemies()[0]!);
    check("a bot hunting someone ELSE doesn't change the trade", Math.abs(dOther - dNo) < 1e-9, { dNo, dOther });
    check("aggro graph read-through (spectatorTargetOf)", gOther.spectatorTargetOf("third") === "someone-else");

    const gOff = mkDuel();
    gOff.setGlobalIntel({ mines: [], bots: [{ id: "third", weapon: "sword", pos: [60, 50], hp: 160, targetId: "me" }] });
    const polOff = mergePolicy(DEFAULT_POLICY, { spectatorHunterWeight: 0 });
    const dOff = tradeAdvantage({ gs: gOff, directive: DEFAULT_DIRECTIVE, policy: polOff, tick: 100 }, gOff.enemies()[0]!);
    check("spectatorHunterWeight 0 disables the hunter share", Math.abs(dOff - dNo) < 1e-9, { dNo, dOff });

    // New knobs ride the clamp table + Tuner patch schema like every sibling.
    const clamped = mergePolicy(DEFAULT_POLICY, {
      spectatorHunterWeight: 9,
      spectatorHunterRadius: 100,
      pathfindDangerWeight: -5,
    });
    check(
      "new spectator/pathfind knobs clamp to safe ranges",
      clamped.spectatorHunterWeight === 1 && clamped.spectatorHunterRadius === 25 && clamped.pathfindDangerWeight === 0,
      clamped,
    );
    check(
      "PolicyPatchSchema accepts the new knobs",
      PolicyPatchSchema.safeParse({ spectatorIntel: false, spectatorHunterWeight: 0.5, pathfindDangerWeight: 2, reasoning: "x" }).success,
    );

    // Round transitions void the intel with every other transient observation.
    const gsR = freshGameState();
    gsR.applyTick(tickFrom(self(), []));
    gsR.setGlobalIntel({ mines: [{ pos: [53, 50], ownerId: "v" }], bots: [] });
    gsR.applyRoundStart({ type: "round_start", round_number: 2 } as RoundStartMsg);
    check("round_start clears spectator intel", gsR.hazardTiles().length === 0, gsR.hazardTiles());
  }

  console.log("\nknowledge dump & restore (repo-persisted learning)");
  {
    const dumpDir = mkdtempSync(join(tmpdir(), "knowledge-"));
    const brainDir = mkdtempSync(join(tmpdir(), "brain-live-"));
    const paths = { dir: dumpDir, brainDir };

    // Seed a "live" system: a learned policy in KV + one brain memory file.
    const busK = new MemoryBus();
    const learned = mergePolicy(DEFAULT_POLICY, { aggression: 0.9, reasoning: "learned it the hard way" });
    await busK.setKV("bot0:arena:kv:policy", learned);
    writeFileSync(
      join(brainDir, "memory-bot0.json"),
      JSON.stringify({ v: 1, savedAt: 1, rounds: [], profiles: [], insights: null }),
    );

    const dumped = await dumpKnowledge(busK, ["", "bot0:"], paths);
    check(
      "dump captures learned KV + memory files",
      dumped.kvKeys.includes("bot0:arena:kv:policy") && dumped.memoryFiles.includes("memory-bot0.json"),
      dumped,
    );

    // Fresh process, empty bus + empty brain dir -> restore seeds both.
    const busFresh = new MemoryBus();
    const brainFresh = mkdtempSync(join(tmpdir(), "brain-fresh-"));
    const restored = await restoreKnowledge(busFresh, { dir: dumpDir, brainDir: brainFresh });
    const seededPolicy = await busFresh.getKV<EnginePolicy>("bot0:arena:kv:policy");
    check(
      "restore seeds an empty system from the dump",
      restored.kvSeeded.includes("bot0:arena:kv:policy") &&
        restored.memorySeeded.includes("memory-bot0.json") &&
        seededPolicy?.aggression === 0.9,
      restored,
    );

    // Live state wins: a policy already on the bus is NOT clobbered.
    const busLive = new MemoryBus();
    const fresher = mergePolicy(learned, { aggression: 0.2 });
    await busLive.setKV("bot0:arena:kv:policy", fresher);
    await restoreKnowledge(busLive, { dir: dumpDir, brainDir: mkdtempSync(join(tmpdir(), "brain-live2-")) });
    const kept = await busLive.getKV<EnginePolicy>("bot0:arena:kv:policy");
    check("restore never clobbers live KV state", kept?.aggression === 0.2, kept?.aggression);

    // Local learning wins: an existing memory file is not overwritten.
    writeFileSync(
      join(brainFresh, "memory-bot0.json"),
      JSON.stringify({ v: 1, savedAt: 999, rounds: [], profiles: [], insights: null }),
    );
    await restoreKnowledge(busFresh, { dir: dumpDir, brainDir: brainFresh });
    const keptFile = JSON.parse(readFileSync(join(brainFresh, "memory-bot0.json"), "utf8")) as { savedAt: number };
    check("restore never overwrites existing memory files", keptFile.savedAt === 999, keptFile);

    // KNOWLEDGE_RESTORE=0 disables the whole replay.
    process.env.KNOWLEDGE_RESTORE = "0";
    const off = await restoreKnowledge(new MemoryBus(), { dir: dumpDir, brainDir: mkdtempSync(join(tmpdir(), "brain-off-")) });
    delete process.env.KNOWLEDGE_RESTORE;
    check("KNOWLEDGE_RESTORE=0 disables the restore", off.kvSeeded.length === 0 && off.memorySeeded.length === 0, off);
  }

  console.log("\nLLM circuit breaker (provider-outage storm protection)");
  {
    // Unreachable base: every call fails fast. Threshold 2 for the test.
    const or = new OpenRouter("test-key", "http://127.0.0.1:9", { after: 2, cooldownMs: 60_000 });
    const req = { model: "m", system: "s", user: "u", timeoutMs: 300 };
    let e1 = "", e2 = "", e3 = "";
    try { await or.chat(req); } catch (e) { e1 = (e as Error).message; }
    try { await or.chat(req); } catch (e) { e2 = (e as Error).message; }
    const t0 = Date.now();
    try { await or.chat(req); } catch (e) { e3 = (e as Error).message; }
    const instant = Date.now() - t0 < 100;
    check("failures below threshold hit the provider", !/circuit open/.test(e1) && !/circuit open/.test(e2), { e1, e2 });
    check("circuit OPENS after threshold — calls fail instantly without API traffic", /circuit open/.test(e3) && instant, { e3, instant });
  }

  console.log("\ncoalition truce break (last fleet standing)");
  {
    const fleet = new Set(["mate1", "mate2"]);
    check("all living outsiders are coalition -> truce over", onlyFleetRemains([{ id: "mate1" }, { id: "mate2" }], fleet));
    check("one real enemy alive -> truce holds", !onlyFleetRemains([{ id: "mate1" }, { id: "stranger" }], fleet));
    check("no spectator frame -> truce holds (conservative)", !onlyFleetRemains(null, fleet));
    check("empty alive list -> truce holds", !onlyFleetRemains([], fleet));
    check("no coalition members known -> truce holds", !onlyFleetRemains([{ id: "mate1" }], new Set()));

    // With the friendly set cleared, an ex-ally is a normal target again:
    // enemies() sees it and selectTarget picks it.
    const gsT = freshGameState();
    gsT.applyTick(tickFrom(self(), [enemy({ bot_id: "mate1", position: [52, 50] })]));
    gsT.setFriendlies(new Set(["mate1"]));
    check("truce on: coalition partner is not an enemy", gsT.enemies().length === 0);
    gsT.setFriendlies(new Set());
    check("truce over: ex-ally is a valid target", gsT.enemies().length === 1);
    const pick = selectTarget({ gs: gsT, directive: DEFAULT_DIRECTIVE, policy: DEFAULT_POLICY, tick: gsT.tick });
    check("selectTarget engages the ex-ally", pick?.bot_id === "mate1", pick);
    check("coopTruceBreak knob rides the clamp table", mergePolicy(DEFAULT_POLICY, { coopTruceBreak: false }).coopTruceBreak === false);

    // Count-based fallback (spectator feed off): REST global alive count vs
    // our own coop-derived alive count.
    check("count fallback: global == ours -> truce over", onlyFleetRemainsByCount(3, 3));
    check("count fallback: an enemy still alive -> truce holds", !onlyFleetRemainsByCount(4, 3));
    check("count fallback: stale our-count (global < ours) -> truce holds", !onlyFleetRemainsByCount(2, 3));
    check("count fallback: no count known -> truce holds", !onlyFleetRemainsByCount(null, 3));
    check("count fallback: solo survivor -> nothing to break", !onlyFleetRemainsByCount(1, 1));

    // aliveAllies counts only FRESH reports with hp > 0 (dead allies keep
    // reporting hp 0 and must not count).
    const busAA = new MemoryBus();
    const coopAA = new Coalition(busAA, () => "self");
    await coopAA.start();
    const reportOf = (botId: string, hp: number) => ({
      ts: Date.now(), botId, name: botId, weapon: "sword" as const, pos: [50, 50] as [number, number], hp, enemies: [], mines: [],
    });
    await busAA.publish(Channels.coop, reportOf("mateA", 80));
    await busAA.publish(Channels.coop, reportOf("mateB", 0)); // dead, still reporting
    await new Promise((r) => setTimeout(r, 20));
    check("aliveAllies counts living allies only", coopAA.aliveAllies() === 1, coopAA.aliveAllies());
    coopAA.stop();
  }

  console.log("\nthreat-weighted A* retreat (pathfinder)");
  {
    // Weighted findPath detours around a danger stripe with a cheap gap while
    // the unweighted planner goes straight through.
    const stripeCost = (c: number, r: number): number => (c === 55 && r !== 45 ? 100 : 0);
    const straight = findPath([50, 50], [60, 50], 100, () => true);
    const weighted = findPath([50, 50], [60, 50], 100, () => true, stripeCost);
    check("unweighted path crosses the stripe head-on", straight !== null && straight.some(([c, r]) => c === 55 && r === 50));
    check(
      "weighted path detours through the cheap gap",
      weighted !== null && weighted.some(([c, r]) => c === 55 && r === 45) && !weighted.some(([c, r]) => c === 55 && r !== 45),
      weighted,
    );

    // plannedRetreatStep: knob off -> null (callers keep the greedy step).
    const gsPlan = freshGameState();
    gsPlan.applyTick(tickFrom(self(), [enemy({ bot_id: "brute", position: [52, 50], attack_range: 1, threat_score: 8 })]));
    check("pathfindDangerWeight 0 disables the planner", gsPlan.plannedRetreatStep(0) === null);
    const step = gsPlan.plannedRetreatStep(DEFAULT_POLICY.pathfindDangerWeight);
    check(
      "planned retreat step is a unit step away from the threat",
      step !== null &&
        Math.max(Math.abs(step[0]), Math.abs(step[1])) === 1 &&
        chebyshev([50 + step[0], 50 + step[1]], [52, 50]) > chebyshev([50, 50], [52, 50]),
      step,
    );
    if (step) {
      check("planned step lands on safe ground", gsPlan.isSafeStep(50 + step[0], 50 + step[1]), step);
    }
    // Nothing dangerous around -> no plan (danger at goal isn't meaningfully
    // lower than here), so quiet phases never burn ticks on phantom retreats.
    const gsCalm = freshGameState();
    gsCalm.applyTick(tickFrom(self(), []));
    check("calm field produces no planned retreat", gsCalm.plannedRetreatStep(1) === null);
  }

  console.log("\nlearnings-authoritative drafting + double_bounty discipline (deep dive 2)");
  {
    const agent2 = new LoadoutAgent();
    const sys = (agent2 as unknown as { systemPrompt(): string }).systemPrompt();
    check("loadout prompt makes weapon history authoritative for every slot", sys.includes("EVIDENCE AUTHORITY") && sys.includes("including index 0"));
    check("loadout prompt bans proven losers", sys.includes("BANNED"));
    check(
      "double_bounty is survival, not aggression, in all three prompts",
      sys.includes("SURVIVAL build") &&
        new StrategistAgent()["systemPrompt"]().includes("do NOT raise aggression") &&
        new TacticianAgent()["systemPrompt"]().includes("MORE cautious"),
    );
  }

  console.log("\ndeterministic draft-evidence enforcement");
  {
    const rates = {
      daggers: { wins: 2, played: 99 },
      bow: { wins: 25, played: 123 },
      sword: { wins: 2, played: 80 },
      staff: { wins: 0, played: 3 },
    };
    check("index 0 proven-loser pick is overridden to the proven winner", enforceWeaponEvidence("daggers", 0, 3, rates) === "bow");
    check(
      "slot 2 with a dead archetype promotes to the GLOBAL proven winner",
      enforceWeaponEvidence("sword", 2, 3, rates) === "bow",
    );
    check("slot 1 loser pick promotes to bow (in its archetype)", enforceWeaponEvidence("staff", 1, 3, { ...rates, staff: { wins: 1, played: 20 } }) === "bow");
    check("solo bots are never overridden", enforceWeaponEvidence("daggers", null, 1, rates) === null);
    check("unproven picks (<10 played) are never overridden", enforceWeaponEvidence("spear", 0, 3, rates) === null);
    check("healthy picks stand", enforceWeaponEvidence("bow", 1, 3, rates) === null);
  }

  console.log("\nally repulsion: the pack spaces itself so splash can't form");
  {
    const gsR = freshGameState();
    gsR.applyTick(tickFrom(self(), [enemy({ bot_id: "ally", position: [52, 50] })]));
    gsR.setFriendlies(new Set(["ally"]));
    const nearAlly = gsR.threatField().danger(52, 50);
    const besideAlly = gsR.threatField().danger(53, 50);
    const clear = gsR.threatField().danger(46, 50);
    check("tiles near an ally carry repulsion cost", nearAlly > clear && besideAlly > clear, { nearAlly, besideAlly, clear });
    check("repulsion is mild, not a hazard wall", nearAlly - clear <= 20, nearAlly - clear);
    // Repulsion is local: beyond 2 tiles of the ally there is no cost at all
    // (an ally radiates no weapon-coverage danger — it's excluded from
    // enemies() — so distant tiles must read clean).
    check("repulsion stops beyond 2 tiles of the ally", gsR.threatField().danger(49, 50) === clear, {
      at3: gsR.threatField().danger(49, 50),
      clear,
    });
  }

  console.log("\nbrain memory persistence (disk survives restart + KV expiry)");
  {
    const dir = mkdtempSync(join(tmpdir(), "brain-memory-"));
    process.env.BRAIN_MEMORY_DIR = dir;
    const store = new BrainMemoryStore("bot0");
    check("first boot loads null (no file yet)", store.load() === null);

    const history = new RoundHistory(30);
    const registry = new OpponentRegistry();
    history.push({
      round: 5,
      roundModifier: "none",
      ourWeapon: "daggers",
      kills: 1,
      deaths: 1,
      killedBy: [{ botId: "e1", name: "Lancer", weapon: "bow" }],
      weKilled: [],
      enemyWeaponsSeen: { bow: 2 },
      won: false,
      ticksSurvived: 900,
      hpAtDeath: 0,
    });
    registry.recordKilledUs("e1", "Lancer", "bow", 5);
    store.save({ rounds: history.toJSON(), profiles: registry.toJSON(), insights: null });
    store.flush();

    // "Restart": fresh objects restored from a fresh store on the same dir.
    const store2 = new BrainMemoryStore("bot0");
    const snap = store2.load();
    check("snapshot loads after flush", snap !== null && snap.v === 1);
    const history2 = new RoundHistory(30);
    const registry2 = new OpponentRegistry();
    history2.restore(snap!.rounds);
    registry2.restore(snap!.profiles);
    check("round history survives restart", history2.size() === 1 && history2.recent(1)[0]!.round === 5);
    const lancer = registry2.get("e1");
    check(
      "opponent profile survives restart (weapon + kill ledger)",
      lancer !== null && lancer.primaryWeapon === "bow" && lancer.killsVsUs === 1 && lancer.roundsFaced === 1,
      lancer,
    );
    check(
      "scoped stores use distinct files (parallel bots don't clobber)",
      new BrainMemoryStore("bot1").load() === null,
    );

    // Fleet-wide evidence: a second bot's snapshot on disk is visible to the
    // first bot's loadFleet() — the weapon proof doesn't stay siloed.
    const store3 = new BrainMemoryStore("bot1");
    const h3 = new RoundHistory(30);
    h3.push({
      round: 6,
      roundModifier: "none",
      ourWeapon: "bow",
      kills: 3,
      deaths: 0,
      killedBy: [],
      weKilled: [],
      enemyWeaponsSeen: {},
      won: true,
      ticksSurvived: 1500,
      hpAtDeath: 0,
    });
    store3.save({ rounds: h3.toJSON(), profiles: [], insights: null });
    store3.flush();
    const fleetSnaps = new BrainMemoryStore("bot0").loadFleet();
    const weapons = new Set(fleetSnaps.flatMap((s) => s.rounds.map((r) => r.ourWeapon)));
    check(
      "loadFleet merges every bot's disk memory (bow win visible to bot0)",
      fleetSnaps.length === 2 && weapons.has("bow") && weapons.has("daggers"),
      { snaps: fleetSnaps.length, weapons: [...weapons] },
    );

    // The shared merge helper (used by BOTH the orchestrator and the engine's
    // fallback draft) tallies wins/played across the fleet's files.
    const rates = fleetWeaponWinRatesFromDisk(new BrainMemoryStore("bot0"));
    check(
      "fleetWeaponWinRatesFromDisk merges evidence across the fleet",
      rates.bow?.played === 1 && rates.bow.wins === 1 && (rates.daggers?.played ?? 0) >= 1,
      rates,
    );
    delete process.env.BRAIN_MEMORY_DIR;
  }

  console.log("\nenv policy overrides (A/B mechanism)");
  {
    const good = parsePolicyOverrides('{"gankApproachWeight":0,"endgameZoneRadius":0}');
    check("valid JSON object parses", good !== null && good.gankApproachWeight === 0);
    check("junk JSON returns null (never bricks startup)", parsePolicyOverrides("{nope") === null);
    check("non-object JSON returns null", parsePolicyOverrides("[1,2]") === null && parsePolicyOverrides('"x"') === null);
    check("unset returns null", parsePolicyOverrides(undefined) === null);
    const applied = mergePolicy(DEFAULT_POLICY, { ...good!, source: "env-override" });
    check(
      "overrides ride the clamp table and disable the new behaviors",
      applied.gankApproachWeight === 0 && applied.endgameZoneRadius === 0 && applied.source === "env-override",
    );
  }

  console.log("\ntactician sees the round modifier");
  {
    const tac = new TacticianAgent();
    const snap = {
      ts: Date.now(),
      round: 4,
      tick: 100,
      roundModifier: "hazard_storm",
      self: { id: "me" },
      zone: {},
      enemies: [],
      nearbyPickups: [],
      nearbyHazards: [],
      nearbyTerrain: [],
      lastSeenEnemies: [],
      recentKills: [],
    } as unknown as GameSnapshot;
    const prompt = (tac as unknown as { userPrompt(i: { snapshot: GameSnapshot; current: Directive }): string }).userPrompt({
      snapshot: snap,
      current: DEFAULT_DIRECTIVE,
    });
    check("tactician prompt carries round_modifier", prompt.includes('"round_modifier":"hazard_storm"'), prompt.slice(0, 80));
    check(
      "tactician system prompt instructs modifier reactions",
      (tac as unknown as { systemPrompt(): string }).systemPrompt().includes("round_modifier"),
    );
  }

  console.log("\ntelemetry log: per-bot channels (fleet mode doesn't clobber)");
  {
    const dir = mkdtempSync(join(tmpdir(), "telemetry-fleet-"));
    process.env.TELEMETRY_LOG = "1";
    process.env.TELEMETRY_LOG_DIR = dir;
    const t = new TelemetryLog();
    const tick = (n: number) => ({
      tick: n,
      priority: "engage_target" as const,
      fellThrough: [],
      reason: "test",
      hp: 100,
      maxHp: 100,
      posX: 1,
      posY: 1,
    });
    // Two engines interleaving within one process, as a fleet does.
    t.setActiveBot("bot-a");
    t.roundStart("9");
    t.tickDecision(tick(1));
    t.setActiveBot("bot-b");
    t.roundStart("9");
    t.tickDecision(tick(2));
    t.setActiveBot("bot-a");
    t.tickDecision(tick(3));
    t.roundEnd("9", "win");
    t.setActiveBot("bot-b");
    t.roundEnd("9", "loss");
    await new Promise((r) => setTimeout(r, 150)); // let streams flush
    const a = readFileSync(join(dir, "bot-a_9.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const b = readFileSync(join(dir, "bot-b_9.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    check(
      "each bot gets its own round file with only its own events",
      a.length === 4 && b.length === 3 && a.every((e) => e.t !== "tick_decision" || [1, 3].includes(e.tick)) && b.every((e) => e.t !== "tick_decision" || e.tick === 2),
      { a: a.map((e) => [e.t, e.tick]), b: b.map((e) => [e.t, e.tick]) },
    );
    check(
      "round boundaries carry the right botId and outcome",
      a[0]!.botId === "bot-a" && a[3]!.outcome === "win" && b[0]!.botId === "bot-b" && b[2]!.outcome === "loss",
    );
    delete process.env.TELEMETRY_LOG;
    delete process.env.TELEMETRY_LOG_DIR;
  }

  console.log("\noutcome log (win-rate pass measurement infra)");
  {
    const kb = (botId: string, name: string): { botId: string; name: string; weapon: Weapon } => ({
      botId,
      name,
      weapon: "sword",
    });
    check("won round classifies as won", classifyCauseOfDeath({ won: true, killedBy: [kb("e1", "Foo")] }) === "won");
    check(
      "loss with a bot kill classifies as bot_kill",
      classifyCauseOfDeath({ won: false, killedBy: [kb("e1", "Foo")] }) === "bot_kill",
    );
    check(
      "loss with no death frame classifies as no_death_recorded",
      classifyCauseOfDeath({ won: false, killedBy: [] }) === "no_death_recorded",
    );
    check(
      "zone/void killer classifies as environment",
      classifyCauseOfDeath({ won: false, killedBy: [kb("safe_zone", "The Zone")] }) === "environment" &&
        classifyCauseOfDeath({ won: false, killedBy: [kb("x", "Void Tile")] }) === "environment",
    );
    check(
      "last hit decides the cause (bot after zone tick)",
      classifyCauseOfDeath({ won: false, killedBy: [kb("safe_zone", "The Zone"), kb("e2", "Bar")] }) === "bot_kill",
    );
    check(
      "death frame with no bot credited classifies as environment",
      classifyCauseOfDeath({ won: false, killedBy: [kb("", "")] }) === "environment",
    );

    // Write-path roundtrip in an isolated dir: entries land as parseable JSONL
    // tagged with variant + policy version, so A/B comparison is possible.
    const dir = mkdtempSync(join(tmpdir(), "outcome-log-"));
    process.env.OUTCOME_LOG_DIR = dir;
    process.env.POLICY_VARIANT = "smoke-variant";
    const freshLog = new OutcomeLog();
    freshLog.record({
      round: 7,
      roundModifier: "fast_zone",
      ourWeapon: "bow",
      kills: 2,
      deaths: 1,
      killedBy: [kb("e9", "Baz")],
      weKilled: [],
      enemyWeaponsSeen: { sword: 1 },
      won: false,
      ticksSurvived: 1234,
      hpAtDeath: 0,
      botId: "me",
      botName: "Smoke",
      label: "",
      policyVersion: 3,
      policySource: "tuner",
      aliveAtEnd: false,
    });
    await new Promise((r) => setTimeout(r, 150)); // appendFile is async fire-and-forget
    const lines = readFileSync(join(dir, "outcomes.jsonl"), "utf8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]!);
    check("outcome entry persisted as JSONL", lines.length === 1 && entry.t === "round_outcome", entry);
    check("outcome entry carries variant tag", entry.variant === "smoke-variant", entry.variant);
    check("outcome entry carries policy version + source", entry.policyVersion === 3 && entry.policySource === "tuner");
    check("outcome entry derives cause of death", entry.causeOfDeath === "bot_kill", entry.causeOfDeath);
    delete process.env.POLICY_VARIANT;
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
