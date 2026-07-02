/* eslint-disable no-console */
/**
 * Offline self-play simulator + policy sweep.
 *
 *   npx tsx scripts/simulate.ts
 *
 * The arena has no server-side simulator, so this is ours: a compact,
 * deterministic combat sim that drives our REAL Controller (via the real
 * GameState / protocol types) against baseline bots using the true weapon table
 * (damage / range / cooldown). It scores different EnginePolicy settings so we
 * can pick better defaults with data instead of guessing — e.g. to fix an
 * over-defensive bot. Not wired into the runtime; a tuning tool only.
 */
import { Controller } from "../src/engine/controller";
import { GameState } from "../src/engine/gameState";
import { telemetry } from "../src/engine/telemetryLog";
import { WEAPONS, DEFAULT_STATS, profileFor } from "../src/engine/weapons";
import { deriveStats, NEUTRAL_STATS } from "../src/shared/derived";
import { DEFAULT_DIRECTIVE, DEFAULT_POLICY, mergePolicy, type EnginePolicy } from "../src/types/internal";
import type {
  ClientAction,
  ConnectedMsg,
  GridVec,
  NearbyBot,
  NearbyEntity,
  SelfState,
  StatBlock,
  TickMsg,
  Weapon,
} from "../src/types/protocol";

const DT = 0.1; // seconds per tick (10 Hz)
const GRID = 100;
const FOG = 7;
const MAX_TICKS = 600;
const ZONE_CENTER: GridVec = [50, 50];

// Seeded RNG for reproducible matches.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

interface SimBot {
  id: string;
  name: string;
  pos: GridVec;
  hp: number;
  maxHp: number;
  weapon: Weapon;
  damage: number;
  attackMult: number;
  defenseRed: number;
  range: number;
  cooldownTicks: number;
  cdRemaining: number;
  dodgeCd: number;
  /** Spec: shove has a 1.5s cooldown (15 ticks); a shove inside it is rejected.
   *  Pass-1's sim omitted this, which structurally hid (and rewarded) shove
   *  spam — see docs/audit/pass2-phase1-trace.md C2. */
  shoveCd: number;
  /** Collected-but-unspent gravity_well pickup charges (spec: use_gravity_well
   *  without one is rejected — the action is simply wasted). */
  gravityCharges: number;
  invuln: number;
  stun: number;
  alive: boolean;
  kills: number;
  dmgDealt: number;
  dmgTaken: number;
  ours: boolean;
  controller?: Controller;
  gs?: GameState;
}

interface SimPickup {
  id: string;
  type: string;
  pos: GridVec;
  taken: boolean;
}

// Combat stats come from the EXACT server formulas (shared/derived.ts) applied
// to each bot's real stat block — so the sim's damage/HP model matches the arena.
function makeBot(id: string, name: string, weapon: Weapon, pos: GridVec, ours: boolean, stats: StatBlock): SimBot {
  const p = profileFor(weapon);
  const d = deriveStats(stats);
  const defenseRed = Math.min(0.75, d.defenseRed + (weapon === "shield" ? 0.5 : 0)); // shield 50% passive
  return {
    id, name, pos, hp: d.maxHp, maxHp: d.maxHp, weapon,
    damage: p.damage, attackMult: d.attackMult, defenseRed, range: p.baseRange,
    cooldownTicks: Math.max(1, Math.round(p.cooldown / DT)), cdRemaining: 0,
    dodgeCd: 0, shoveCd: 0, gravityCharges: 0, invuln: 0, stun: 0, alive: true,
    kills: 0, dmgDealt: 0, dmgTaken: 0, ours,
  };
}

function cheb(a: GridVec, b: GridVec): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
}
function euclid(a: GridVec, b: GridVec): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
function clamp(v: number): number {
  return Math.max(0, Math.min(GRID - 1, Math.round(v)));
}
function stepToward(from: GridVec, to: GridVec): GridVec {
  return [clamp(from[0] + Math.sign(to[0] - from[0])), clamp(from[1] + Math.sign(to[1] - from[1]))];
}

function buildTick(self: SimBot, bots: SimBot[], tick: number, zoneRadius: number, pickups: SimPickup[] = []): TickMsg {
  const nearby: NearbyEntity[] = bots
    .filter((b) => b.alive && b.id !== self.id && euclid(b.pos, self.pos) <= FOG)
    .map<NearbyEntity>((b) => ({
      type: "bot", bot_id: b.id, name: b.name, position: b.pos, hp: b.hp, max_hp: b.maxHp,
      weapon: b.weapon, is_alive: true, avatar_color: "#f00", last_action: "idle",
      is_dodging: b.invuln > 0, is_stunned: b.stun > 0, facing: [1, 0],
      recently_disrupted_ticks: 0, brace_ready: false, bow_charge_level: 0,
      charged_shot_ready: false, rear_exposed: false, near_impact_surface: false,
      has_los: true, attack_range: b.range, can_attack: b.cdRemaining <= 0,
      threat_score: Math.min(10, profileFor(b.weapon).estDps / 4),
    }));
  for (const p of pickups) {
    if (p.taken || euclid(p.pos, self.pos) > FOG) continue;
    nearby.push({ type: "pickup", pickup_id: p.id, pickup_type: p.type, position: p.pos });
  }
  const distC = euclid(self.pos, ZONE_CENTER);
  const s: SelfState = {
    bot_id: self.id, position: self.pos, hp: self.hp, max_hp: self.maxHp, speed: 6,
    weapon: self.weapon, cooldown_remaining: self.cdRemaining * DT, weapon_ready: self.cdRemaining <= 0,
    is_alive: true, kill_streak: 0, round_kills: self.kills, dodge_cooldown: self.dodgeCd,
    invuln_ticks: self.invuln, stun_ticks: self.stun, facing: [1, 0], recently_disrupted_ticks: 0,
    brace_ready: false, bow_charge_ticks: 0, bow_charge_level: 0, charged_shot_ready: false,
    hazard_key_active: false, hazard_key_ticks: 0, bounty_token_bonus: 0, shield_absorb: 0,
    effects: [], last_action_result: null, hits_received: [], kill_feed: [],
    in_safe_zone: distC <= zoneRadius, distance_to_zone_edge: Math.round(zoneRadius - distC),
    zone_radius: zoneRadius, zone_center: ZONE_CENTER, zone_target_center: ZONE_CENTER,
    zone_target_radius: 9, grapple_charges: 2, grapple_cooldown: 0,
  };
  return {
    type: "tick", tick, tick_number: tick, fog_radius: FOG, your_state: s,
    nearby_mines: 0, nearby_entities: nearby,
    safe_zone: { center: ZONE_CENTER, radius: zoneRadius, target_center: ZONE_CENTER, target_radius: 9 },
  };
}

/**
 * Baseline opponent AI. Zone-aware, retreats when low, and KITES with ranged
 * weapons (maintains preferred distance and shoots) — so a purely passive bot
 * never closes the gap and loses, which is what makes the sweep meaningful.
 */
function baselineDecide(self: SimBot, bots: SimBot[], tick: number, zoneRadius: number): ClientAction {
  // Stay in the zone above all else.
  if (euclid(self.pos, ZONE_CENTER) > zoneRadius - 1) {
    return { type: "action", tick, action: "move_to", target_position: ZONE_CENTER };
  }
  const enemies = bots.filter((b) => b.alive && b.id !== self.id);
  if (enemies.length === 0) return { type: "action", tick, action: "idle" };
  let tgt = enemies[0]!;
  for (const e of enemies) if (euclid(self.pos, e.pos) < euclid(self.pos, tgt.pos)) tgt = e;
  const d = cheb(self.pos, tgt.pos);

  if (self.hp < self.maxHp * 0.25) {
    const away: GridVec = [clamp(2 * self.pos[0] - tgt.pos[0]), clamp(2 * self.pos[1] - tgt.pos[1])];
    return { type: "action", tick, action: "move_to", target_position: away };
  }
  const p = profileFor(self.weapon);
  if (p.ranged) {
    // Kite: hold at preferred range, shoot when able, back off if too close.
    if (d <= self.range && self.cdRemaining <= 0) return { type: "action", tick, action: "attack", target: tgt.id };
    if (d < p.preferredRange) {
      const away: GridVec = [clamp(2 * self.pos[0] - tgt.pos[0]), clamp(2 * self.pos[1] - tgt.pos[1])];
      return { type: "action", tick, action: "move_to", target_position: away };
    }
    return { type: "action", tick, action: "move_to", target_position: tgt.pos };
  }
  if (d <= self.range && self.cdRemaining <= 0) return { type: "action", tick, action: "attack", target: tgt.id };
  return { type: "action", tick, action: "move_to", target_position: tgt.pos };
}

function apply(bot: SimBot, a: ClientAction, bots: SimBot[], pickups: SimPickup[] = []): void {
  if (bot.stun > 0) return;
  const byId = (id: string) => bots.find((b) => b.id === id && b.alive);
  switch (a.action) {
    case "move": bot.pos = [clamp(bot.pos[0] + a.direction[0]), clamp(bot.pos[1] + a.direction[1])]; break;
    case "move_to": bot.pos = stepToward(bot.pos, a.target_position); break;
    case "dodge":
      bot.pos = [clamp(bot.pos[0] + a.direction[0] * 2), clamp(bot.pos[1] + a.direction[1] * 2)];
      bot.invuln = 3; bot.dodgeCd = 30; break;
    case "grapple": {
      const t = a.target ? byId(a.target) : undefined;
      if (t && euclid(bot.pos, t.pos) <= 12) bot.pos = stepToward(t.pos, bot.pos); // pull adjacent
      break;
    }
    case "shove": {
      // Spec: 1.5s cooldown — a shove inside it is rejected (wasted tick).
      if (bot.shoveCd > 0) break;
      const t = a.target ? byId(a.target) : undefined;
      if (t && cheb(bot.pos, t.pos) <= 1) {
        bot.shoveCd = 15;
        t.pos = [clamp(2 * t.pos[0] - bot.pos[0]), clamp(2 * t.pos[1] - bot.pos[1])];
        t.stun = 2;
      }
      break;
    }
    case "use_item": {
      const p = pickups.find((x) => x.id === a.item_id && !x.taken);
      if (!p || euclid(bot.pos, p.pos) > 2) break;
      p.taken = true;
      if (/health/i.test(p.type)) bot.hp = Math.min(bot.maxHp, bot.hp + 30);
      else if (/gravity/i.test(p.type)) bot.gravityCharges += 1;
      break;
    }
    case "use_gravity_well": {
      // Spec: needs a collected charge; without one the action is rejected —
      // the tick is simply wasted (which is exactly the cost being audited).
      if (bot.gravityCharges > 0) bot.gravityCharges -= 1;
      break;
    }
    case "attack": {
      const t = byId(a.target);
      if (!t || bot.cdRemaining > 0) break;
      if (cheb(bot.pos, t.pos) > bot.range) break;
      bot.cdRemaining = bot.cooldownTicks;
      if (t.invuln > 0) break;
      let dmg = bot.damage * bot.attackMult * (1 - t.defenseRed);
      if (bot.weapon === "bow" && a.charged) dmg *= 1.5;
      t.hp -= dmg; bot.dmgDealt += dmg; t.dmgTaken += dmg;
      if (t.hp <= 0) { t.alive = false; bot.kills += 1; }
      break;
    }
    default: break; // place_mine / use_gravity_well / use_item / idle
  }
}

interface MatchResult { won: boolean; kills: number; dmgDealt: number; dmgTaken: number; survived: number }

// Our loadout is overridable so weapon-specific behavior paths (daggers flank,
// bow/staff kiting + retreat, staff gravity wells) can actually be exercised —
// pass 1 only ever ran sword, leaving those paths audited statically only.
const OUR_WEAPON: Weapon = (() => {
  const w = process.env.SIM_WEAPON as Weapon | undefined;
  return w && w in WEAPONS ? w : "sword";
})();
// SIM_PICKUPS=1 spawns health + gravity_well pickups so the pickup/gravity
// subsystems (0% coverage in pass 1) are reachable.
const WITH_PICKUPS = process.env.SIM_PICKUPS === "1";

function runMatch(policy: EnginePolicy, aggression: number, seed: number, roundId = `sim_${seed}`): MatchResult {
  telemetry.setBotId("ours");
  telemetry.roundStart(roundId);
  const r = rng(seed);
  const spawn = (): GridVec => [10 + Math.floor(r() * 80), 10 + Math.floor(r() * 80)];
  const oppWeapons: Weapon[] = ["sword", "bow", "daggers", "spear", "staff"];
  const pickups: SimPickup[] = [];
  if (WITH_PICKUPS) {
    for (let i = 0; i < 4; i++) pickups.push({ id: `hp${i}`, type: "health_pack", pos: spawn(), taken: false });
    for (let i = 0; i < 2; i++) pickups.push({ id: `gw${i}`, type: "gravity_well", pos: spawn(), taken: false });
  }

  const bots: SimBot[] = [];
  // Ours fights with the fight-power-optimal build for OUR_WEAPON; baselines use neutral.
  const ours = makeBot("ours", "Ours", OUR_WEAPON, spawn(), true, DEFAULT_STATS[OUR_WEAPON]);
  ours.controller = new Controller();
  ours.gs = new GameState();
  ours.gs.applyConnected({
    type: "connected", bot_id: "ours", arena_size: [2000, 2000], grid_size: [GRID, GRID],
    cell_size: 20, fog_radius: FOG, available_weapons: [], stat_budget: 20, stat_min: 1,
    stat_max: 10, timeout_seconds: 10, last_loadout: null,
  } as ConnectedMsg);
  ours.gs.setConfirmedAttackRange(ours.range);
  ours.gs.setSelfCombat({ weaponDamage: ours.damage, attackMult: ours.attackMult, cooldownSeconds: WEAPONS[OUR_WEAPON].cooldown, maxHp: ours.maxHp, defenseRed: ours.defenseRed });
  ours.controller.setPolicy(policy);
  ours.controller.setDirective({ ...DEFAULT_DIRECTIVE, aggression, source: "sim" });
  ours.controller.onRoundStart();
  bots.push(ours);
  for (let i = 0; i < 5; i++) bots.push(makeBot(`opp${i}`, `Opp${i}`, oppWeapons[i]!, spawn(), false, NEUTRAL_STATS));

  let survived = 0;
  for (let tick = 0; tick < MAX_TICKS; tick++) {
    const alive = bots.filter((b) => b.alive);
    if (alive.length <= 1) break;
    if (ours.alive) survived = tick;
    const zoneRadius = Math.max(9, 45 - (tick / 250) * 36);

    const actions = new Map<string, ClientAction>();
    for (const b of alive) {
      if (b.ours && b.controller && b.gs) {
        b.gs.applyTick(buildTick(b, bots, tick, zoneRadius, pickups));
        actions.set(b.id, b.controller.decide(b.gs));
      } else {
        actions.set(b.id, baselineDecide(b, bots, tick, zoneRadius));
      }
    }
    for (const b of alive) apply(b, actions.get(b.id)!, bots, pickups);

    for (const b of bots) {
      if (!b.alive) continue;
      if (b.cdRemaining > 0) b.cdRemaining--;
      if (b.dodgeCd > 0) b.dodgeCd--;
      if (b.shoveCd > 0) b.shoveCd--;
      if (b.invuln > 0) b.invuln--;
      if (b.stun > 0) b.stun--;
      if (euclid(b.pos, ZONE_CENTER) > zoneRadius) {
        b.hp -= 3; b.dmgTaken += 3;
        if (b.hp <= 0) b.alive = false;
      }
    }
  }
  const aliveNow = bots.filter((b) => b.alive);
  const won = ours.alive && aliveNow.length === 1;
  telemetry.roundEnd(roundId, won ? "win" : "loss");
  return {
    won,
    kills: ours.kills, dmgDealt: Math.round(ours.dmgDealt), dmgTaken: Math.round(ours.dmgTaken),
    survived,
  };
}

function score(rs: MatchResult[]): { s: number; win: number; kills: number; dd: number; dt: number; surv: number } {
  const n = rs.length;
  const win = rs.filter((x) => x.won).length / n;
  const kills = rs.reduce((a, x) => a + x.kills, 0) / n;
  const dd = rs.reduce((a, x) => a + x.dmgDealt, 0) / n;
  const dt = rs.reduce((a, x) => a + x.dmgTaken, 0) / n;
  const surv = rs.reduce((a, x) => a + x.survived, 0) / n;
  const s = win * 120 + kills * 25 + dd * 0.12 - dt * 0.12 + surv * 0.03;
  return { s, win, kills, dd, dt, surv };
}

interface Cfg { name: string; aggression: number; patch: Partial<EnginePolicy> }
const CONFIGS: Cfg[] = [
  { name: "current(defaults)", aggression: 0.55, patch: { minTradeAdvantage: -0.1, dodgeEagerness: 0.5, kiteRangeBias: 0 } },
  { name: "balanced+",         aggression: 0.7,  patch: { minTradeAdvantage: -0.3, dodgeEagerness: 0.4, kiteRangeBias: 0 } },
  { name: "aggressive",        aggression: 0.8,  patch: { minTradeAdvantage: -0.45, dodgeEagerness: 0.35, kiteRangeBias: -1 } },
  { name: "very_aggressive",   aggression: 0.95, patch: { minTradeAdvantage: -0.6, dodgeEagerness: 0.25, kiteRangeBias: -1 } },
  { name: "aggressive+dodge",  aggression: 0.8,  patch: { minTradeAdvantage: -0.45, dodgeEagerness: 0.5, kiteRangeBias: -1 } },
  { name: "defensive",         aggression: 0.35, patch: { minTradeAdvantage: 0.1, dodgeEagerness: 0.7, kiteRangeBias: 1 } },
];

function main(): void {
  // Overridable so a Phase 2 audit run can pull a "handful" of rounds
  // (SIM_MATCHES=3) with TELEMETRY_LOG=1 instead of the full sweep — default
  // behaviour/output is unchanged when unset.
  const MATCHES = Number(process.env.SIM_MATCHES) || 24;
  console.log(`\nSelf-play sweep — 1 bot (${OUR_WEAPON}) vs 5 baselines${WITH_PICKUPS ? " + pickups" : ""}, ${MATCHES} matches each\n`);
  const rows: { name: string; r: ReturnType<typeof score> }[] = [];
  // A/B override for the win-rate pass: SIM_GANK_WEIGHT=0 reproduces the
  // pre-gank-anticipation trade math on identical seeds.
  const gankOverride = process.env.SIM_GANK_WEIGHT !== undefined ? { gankApproachWeight: Number(process.env.SIM_GANK_WEIGHT) } : {};
  // SIM_ENDGAME_RADIUS=0 reproduces pre-endgame-posture behavior on identical seeds.
  const endgameOverride =
    process.env.SIM_ENDGAME_RADIUS !== undefined ? { endgameZoneRadius: Number(process.env.SIM_ENDGAME_RADIUS) } : {};
  for (const cfg of CONFIGS) {
    const policy = mergePolicy(DEFAULT_POLICY, { ...cfg.patch, ...gankOverride, ...endgameOverride, aggression: cfg.aggression });
    const results: MatchResult[] = [];
    for (let m = 0; m < MATCHES; m++) {
      const seed = 1000 + m * 7 + cfg.name.length;
      results.push(runMatch(policy, cfg.aggression, seed, `${cfg.name}_m${m}`));
    }
    rows.push({ name: cfg.name, r: score(results) });
  }
  rows.sort((a, b) => b.r.s - a.r.s);
  console.log("rank  config              score   win%   kills  dmgDealt  dmgTaken  survival");
  console.log("----  ------------------  ------  -----  -----  --------  --------  --------");
  rows.forEach((row, i) => {
    const r = row.r;
    console.log(
      `${String(i + 1).padStart(2)}.   ${row.name.padEnd(18)}  ${r.s.toFixed(1).padStart(6)}  ${(r.win * 100).toFixed(0).padStart(4)}%  ${r.kills.toFixed(2).padStart(5)}  ${r.dd.toFixed(0).padStart(8)}  ${r.dt.toFixed(0).padStart(8)}  ${r.surv.toFixed(0).padStart(8)}`,
    );
  });
  console.log(`\nBest: ${rows[0]!.name}\n`);
}

main();
