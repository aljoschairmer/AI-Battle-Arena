import type { ClientAction, GridVec, NearbyBot, NearbyPickup } from "../../types/protocol";
import {
  chebyshev,
  clampToGrid,
  dist,
  perpendicularStep,
  toUnitStep,
} from "../../shared/geometry";
import { profileFor } from "../weapons";
import { type DecisionContext, isEndgame, move, moveTo } from "./context";

/**
 * Positioning relative to a target. Melee bots close in; ranged bots hold near
 * their preferred range and kite/strafe to stay alive while dealing damage.
 *
 * Daggers: tries to circle to the rear of the target (rear_exposed gives backstab bonus).
 */
export function positionForCombat(ctx: DecisionContext, target: NearbyBot): ClientAction {
  const { gs, tick } = ctx;
  const self = gs.self!;
  const me = gs.position;
  const d = dist(me, target.position);
  const profile = profileFor(self.weapon);
  // Intercept where the target is heading, not where it was (target leading).
  const lead = gs.predictEnemyPos(target, ctx.policy.leadTicks);

  if (!profile.ranged) {
    // Daggers: try to get behind the target for backstab bonus (Tuner-toggleable)
    if (ctx.policy.daggerFlank && self.weapon === "daggers" && !target.rear_exposed) {
      const behind = flankingPosition(me, target.position, target.facing);
      if (behind && gs.isPassable(behind[0], behind[1])) {
        return moveTo(tick, behind);
      }
    }
    return moveTo(tick, lead);
  }

  const range = gs.effectiveAttackRange();
  // kiteRangeBias (LLM-tunable): + holds further out, − fights closer.
  const preferred = Math.max(1, Math.min(profile.preferredRange + ctx.policy.kiteRangeBias, range));

  // Too close — back off to open the gap (kite), wall-aware.
  if (d < preferred - 0.5) {
    const away = gs.stepAwayFrom(target.position);
    const perp = perpendicularStep(me, target.position);
    const step = pickSafe(ctx, [away, safePerp(perp), safePerp([-perp[0], -perp[1]] as GridVec)]);
    if (step) return move(tick, step);
  }

  // Too far — advance to get into firing range (toward the lead point).
  if (d > range + 0.25) {
    return moveTo(tick, lead);
  }

  // In the sweet spot — strafe perpendicular to be a harder target.
  const perp = perpendicularStep(me, target.position);
  const step = pickSafe(ctx, [safePerp(perp), safePerp([-perp[0], -perp[1]] as GridVec)]);
  if (step) return move(tick, step);

  // Nowhere safe to strafe — hold position aimed at the target.
  return moveTo(tick, target.position);
}

const PICKUP_VALUE: Record<string, number> = {
  health: 1.0,
  hp: 1.0,
  heal: 1.0,
  shield: 0.9,    // absorbs next hit — nearly as good as healing
  hazard: 0.85,   // suppresses ALL zone/burn/void damage — huge in hazard rounds
  gravity: 0.75,  // cluster control — strong for staff/grapple
  speed: 0.7,     // mobility is survivability
  grapple: 0.65,
  cooldown: 0.6,
  bounty: 0.55,
  overdrive: 0.5, // attack speed luxury — not worth much when low HP
  damage: 0.4,    // pure damage luxury — being alive matters more
  attack: 0.4,
  relay: 0.3,
};

function pickupScore(type: string): number {
  const t = type.toLowerCase();
  for (const [key, val] of Object.entries(PICKUP_VALUE)) {
    if (t.includes(key)) return val;
  }
  return 0.35;
}

/**
 * Opportunistically grab a nearby, valuable, safe pickup.
 * When burning/DoT'd, heavily prioritizes health pickups regardless of distance.
 */
export function grabPickup(ctx: DecisionContext): ClientAction | null {
  const { gs, tick, directive } = ctx;
  const me = gs.position;
  const pickups = gs.pickups();
  if (pickups.length === 0) return null;

  const burning = gs.hasNegativeEffect();
  // Detour budget anchored on the LLM-tunable base, widened when burning or playing safe.
  const base = ctx.policy.pickupDetourMax;
  const maxDetour = burning ? base + 4 : directive.posture === "defensive" || directive.posture === "retreat" ? base + 2 : base;
  const hazards = gs.hasHazardKey() ? [] : gs.hazardTiles();

  let best: NearbyPickup | null = null;
  let bestScore = -Infinity;

  for (const p of pickups) {
    const d = dist(me, p.position);
    // When burning, only prioritize health; otherwise use detour budget
    const isHealth = /health|hp|heal/i.test(p.pickup_type);
    const effectiveMax = burning && isHealth ? base + 4 : maxDetour;
    if (d > effectiveMax) continue;
    if (enemyControls(gs.enemies(), p.position)) continue;
    if (recentEnemyNear(gs, p.position, ctx.policy.pickupStaleEnemyTicks)) continue;
    // A pack next to a hazard tile gets us shoved right back off it by
    // survivalBehavior the moment we arrive — the two behaviours would then
    // fight over the same tile every tick. Skip it rather than get stuck.
    if (hazardAdjacent(hazards, p.position)) continue;
    const score = pickupScore(p.pickup_type) * 10 - d;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  if (!best) return null;

  if (dist(me, best.position) <= 0.75) {
    return { type: "action", tick, action: "use_item", item_id: best.pickup_id };
  }
  return moveTo(tick, best.position);
}

/**
 * Nothing to fight and nothing to grab: pre-position for the shrinking zone.
 * Priorities:
 *   1. control_center objective → move toward a WORTHWHILE capture pad
 *   2. hunt_bounty objective → walk the live bounty beacon (fog-exempt position)
 *   3. Search last-seen enemies
 *   4. Drift toward zone target center
 */
export function defaultReposition(ctx: DecisionContext): ClientAction {
  const { gs, tick, directive } = ctx;
  const self = gs.self!;
  const zoneCenter =
    self.zone_target_radius < self.zone_radius ? self.zone_target_center : self.zone_center;

  // CTF: with no target/pickup claiming the tick, play the flags — return our
  // dropped flag (touch = instant return) or move on the stealable enemy flag.
  // Captures win CTF rounds, not kills; rounds don't even end by elimination.
  // (Carrying is handled higher up in the controller — a live carry must not
  // be diverted by combat/loot at all.)
  if (gs.gameMode === "ctf") {
    const goal = gs.ctfObjectiveGoal();
    if (goal && (goal.pos[0] !== gs.position[0] || goal.pos[1] !== gs.position[1])) {
      return moveTo(tick, goal.pos);
    }
  }

  // control_center objective: head toward the capture pad — but only one the
  // live pad state says is worth standing on (capturePadGoal encapsulates the
  // ready/contested/owner state machine), BOUNDED by capturePadMove's local
  // stand-streak so we never park forever (the "stuck in the middle of the
  // map" bug: the central pad turned the bot into a stationary free kill).
  // Skipped during sudden death: squatting a tile while the floor randomizes
  // into void is how bots die to the environment.
  if (directive.objective === "control_center" && !gs.suddenDeath) {
    const cap = capturePadMove(ctx);
    if (cap) return cap;
  }

  // hunt_bounty with a live beacon: its position is global and fog-exempt —
  // walk it down directly instead of patrolling and hoping.
  if (directive.objective === "hunt_bounty" && ctx.policy.huntBountyBeacon && gs.bountyBeacon) {
    return moveTo(tick, gs.bountyBeacon.position);
  }

  // Endgame: with the zone this small, ground near the shrink-target center
  // IS the win condition — hold it and let fights come to us instead of
  // roaming to hints/last-seen ghosts that can strand us at the closing edge.
  if (isEndgame(ctx)) {
    const center = self.zone_target_radius < self.zone_radius ? self.zone_target_center : self.zone_center;
    const targetRadius = Math.min(self.zone_target_radius, self.zone_radius);
    const holdRadius = Math.max(2, targetRadius * ctx.policy.endgameCenterHoldFraction);
    if (dist(gs.position, center) > holdRadius) return moveTo(tick, center);
    // Already on center ground — fall through to the normal idle chain
    // (search/loot/pad), which the tiny zone naturally keeps tight.
  }

  const search = searchLastSeenEnemy(ctx);
  if (search) return search;

  // No enemies nearby — loot valuable pickups before patrolling.
  const loot = seekPickup(ctx);
  if (loot) return loot;

  // Taking hits with NO visible enemy (a bow's range 8 beats our fog 7, so a
  // sniper can be invisible): never stand, park, or walk a straight line —
  // serpentine toward the nearest hinted bot (forcing fog contact with the
  // shooter) or toward the zone target. The strafe component flips every few
  // ticks so we're a genuinely moving target between dodge cooldowns.
  if (gs.underRecentFire()) {
    const evade = serpentineStep(ctx, zoneCenter);
    if (evade) return evade;
  }

  // Follow the server's nav hints (only sent when no enemy is in fog): toward
  // the nearest bot to start a fight, or — when hurt / a pickup is closer —
  // toward hinted pickups to build back up first (see followHint).
  const hinted = followHint(ctx);
  if (hinted) return hinted;

  // Quiet phase + a live bounty beacon on someone else: walking toward the
  // beacon beats aimless patrol (it's a real, global position — and healthy is
  // the operative word; hurt bots already took the heal branches above).
  if (
    ctx.policy.huntBountyBeacon &&
    gs.bountyBeacon &&
    gs.hpFraction() >= ctx.policy.idleHealBelowHpFraction
  ) {
    return moveTo(tick, gs.bountyBeacon.position);
  }

  // Still nothing? Use the quiet phase to improve our position: capture a
  // nearby pad (+12 score, 20 shield, 1.2x damage — docs/arena-spec.md)
  // instead of walking aimless patrol circles. Only a pad the live state
  // machine says is worth it (capturePadGoal), bounded by capturePadMove's
  // stand-streak (no infinite parking), and never during sudden death
  // (standing still on randomizing void tiles).
  if (ctx.policy.idleCapturePads && !gs.suddenDeath) {
    const cap = capturePadMove(ctx);
    if (cap) return cap;
  }

  // Nothing to loot either — patrol the zone to find enemies.
  const patrolTarget = patrolPoint(gs, tick, zoneCenter);
  return moveTo(tick, patrolTarget);
}

/**
 * Bounded capture-pad routine shared by the control_center objective and the
 * idle branch. Walks to the nearest available pad and holds it just long
 * enough to capture (spec: 20 uncontested ticks; GameState.notePadStand allows
 * a margin, then puts the pad on a cooldown so we move on — the owner keeps
 * receiving control pulses without standing there). Never parks while taking
 * fire from an unseen attacker.
 */
function capturePadMove(ctx: DecisionContext): ClientAction | null {
  const { gs, tick } = ctx;
  if (gs.underRecentFire()) return null;
  // capturePadGoal reads the live pad state machine (ready/contested/owner,
  // pass-4): a pad on server cooldown or contested by others is already
  // filtered out here. The local stand-streak below stays as the belt-and-
  // suspenders bound for when no live pad state is available (terrain-'C'
  // fallback) or the server state goes stale.
  const pad = gs.capturePadGoal();
  if (!pad || !gs.padAvailable(pad)) return null;
  const me = gs.position;
  if (me[0] === pad[0] && me[1] === pad[1]) {
    gs.notePadStand(pad, tick);
    if (!gs.padAvailable(pad)) return null; // capture done — move on
    return moveTo(tick, pad); // hold the pad while the capture progresses
  }
  return moveTo(tick, pad);
}

/**
 * Weaving unit step toward `fallbackGoal` (or the nearest hinted bot): base
 * direction plus a perpendicular strafe component that flips sign every 5
 * ticks. Used when we're being hit by something we can't see — standing still
 * or walking a straight line is exactly what the shooter wants.
 */
function serpentineStep(ctx: DecisionContext, fallbackGoal: GridVec): ClientAction | null {
  const { gs, tick } = ctx;
  const me = gs.position;
  const botHint = (gs.hints ?? [])
    .filter((h) => h.hint_type === "bot")
    .sort((a, b) => a.distance - b.distance)[0];
  const goal: GridVec = botHint
    ? clampToGrid([me[0] + botHint.direction[0] * 6, me[1] + botHint.direction[1] * 6], gs.gridSize)
    : fallbackGoal;
  const base = gs.stepToward(goal);
  const flip = Math.floor(tick / 5) % 2 === 0 ? 1 : -1;
  const strafe: GridVec = [-base[1] * flip, base[0] * flip];
  const weave = toUnitStep([base[0] + strafe[0], base[1] + strafe[1]]);
  const step = pickSafe(ctx, [weave, strafe, base]);
  return step ? move(tick, step) : null;
}

/**
 * Follow the server's navigation hints. The arena sends `tick.hints` only when
 * no enemy is inside our fog — directions to the nearest few bots and the
 * nearest pickup of each type. `direction` is a normalized vector; we project
 * a grid target a few tiles along it and let the server pathfind.
 *
 * Hint choice is state-aware (pass-2 follow-up): the old rule was "nearest
 * bot hint always wins", so a quiet arena with few bots meant the bot either
 * marched hurt into its next fight or stood around ignoring known loot.
 *  - hurt (below idleHealBelowHpFraction): health pickup hints first, then
 *    any pickup hint, then bots — top HP back up before seeking a fight;
 *  - healthy: nearest bot hint, unless a pickup hint is strictly closer
 *    (cheap value on the way — the fight is further out anyway).
 */
export function followHint(ctx: DecisionContext): ClientAction | null {
  const { gs, tick } = ctx;
  const hints = gs.hints;
  if (!hints || hints.length === 0) return null;

  const byDist = (a: { distance: number }, b: { distance: number }) => a.distance - b.distance;
  const bots = hints.filter((h) => h.hint_type === "bot").sort(byDist);
  const pickups = hints.filter((h) => h.hint_type === "pickup").sort(byDist);
  const health = pickups.filter((h) => /health|hp|heal/i.test(h.pickup_type ?? ""));

  const hurt = gs.hpFraction() < ctx.policy.idleHealBelowHpFraction;
  let chosen = hurt
    ? health[0] ?? pickups[0] ?? bots[0]
    : bots[0] && pickups[0] && pickups[0].distance < bots[0].distance
      ? pickups[0]
      : bots[0] ?? pickups[0];
  chosen ??= [...hints].sort(byDist)[0];
  if (!chosen) return null;

  const cell = gs.cellSize || 20;
  const reach = Math.min(10, Math.max(3, Math.round(chosen.distance / cell)));
  const target = clampToGrid(
    [gs.position[0] + chosen.direction[0] * reach, gs.position[1] + chosen.direction[1] * reach],
    gs.gridSize,
  );
  return moveTo(tick, target);
}

/**
 * When no enemies are visible, route toward the best visible pickup regardless
 * of detour distance. Health is top priority; any pickup beats aimless patrol.
 * Still skips pickups an enemy is camping (within 1.5 tiles).
 */
function seekPickup(ctx: DecisionContext): ClientAction | null {
  const { gs, tick } = ctx;
  const me = gs.position;
  const pickups = gs.pickups();
  if (pickups.length === 0) return null;

  const hazards = gs.hasHazardKey() ? [] : gs.hazardTiles();
  let best: NearbyPickup | null = null;
  let bestScore = -Infinity;

  for (const p of pickups) {
    if (enemyControls(gs.enemies(), p.position)) continue;
    if (recentEnemyNear(gs, p.position, ctx.policy.pickupStaleEnemyTicks)) continue;
    if (hazardAdjacent(hazards, p.position)) continue;
    const d = dist(me, p.position);
    const score = pickupScore(p.pickup_type) * 10 - d * 0.5;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  if (!best) return null;

  if (dist(me, best.position) <= 0.75) {
    return { type: "action", tick, action: "use_item", item_id: best.pickup_id };
  }
  return moveTo(tick, best.position);
}

/**
 * Pick a patrol waypoint offset from the zone center, rotating through 8
 * compass directions every 30 ticks. The offset is 40% of the current zone
 * radius so the bot sweeps a wide arc without leaving the zone.
 */
function patrolPoint(gs: import("../gameState").GameState, tick: number, center: GridVec): GridVec {
  const OFFSETS: GridVec[] = [
    [1, 0], [1, 1], [0, 1], [-1, 1],
    [-1, 0], [-1, -1], [0, -1], [1, -1],
  ];
  const self = gs.self!;
  const me = gs.position;
  const radius = Math.max(4, (self.zone_radius ?? 20) * 0.4);
  // Sudden death: rotate waypoints 3x faster so the bot never dwells on a tile
  // while the floor randomizes into instant-death void ("Keep moving!" — spec).
  const baseSlot = Math.floor(tick / (gs.suddenDeath ? 10 : 30)) % OFFSETS.length;
  // Advance past impassable waypoints AND our own tile — returning the tile
  // we're standing on turns patrol into standing still.
  for (let i = 0; i < OFFSETS.length; i++) {
    const [dx, dy] = OFFSETS[(baseSlot + i) % OFFSETS.length]!;
    const clamped: GridVec = [
      Math.max(0, Math.min(gs.gridSize - 1, Math.round(center[0] + dx * radius))),
      Math.max(0, Math.min(gs.gridSize - 1, Math.round(center[1] + dy * radius))),
    ];
    if (!gs.isPassable(clamped[0], clamped[1])) continue;
    if (clamped[0] === me[0] && clamped[1] === me[1]) continue;
    return clamped;
  }
  return center;
}

function searchLastSeenEnemy(ctx: DecisionContext): ClientAction | null {
  const { gs, tick } = ctx;
  if (gs.enemies().length > 0) return null;

  const lastSeen = gs.guessedEnemyPositions(30).sort((a, b) => a.since - b.since);
  for (const target of lastSeen) {
    // Arrived and nothing there: forget the ghost instead of standing on it
    // until the 30-tick memory expires (another stand-still trap).
    if (dist(gs.position, target.position) <= 1) {
      gs.forgetLastSeen(target.bot_id);
      continue;
    }
    // (sprintTo was removed as dead code — it was byte-identical to moveTo;
    // the protocol has no sprint action.)
    return moveTo(tick, target.position);
  }
  return null;
}

// --- helpers ---------------------------------------------------------------

function enemyControls(enemies: NearbyBot[], pos: GridVec): boolean {
  return enemies.some((e) => dist(e.position, pos) <= 1.5);
}

/**
 * Was an enemy seen near `pos` within the last `maxAge` ticks, even if it's
 * since left fog? grabPickup/seekPickup only ever run with ZERO currently-
 * visible enemies (selectTarget claims priority 7 for any visible enemy,
 * however distant or harmless, before either can be reached) — so
 * enemyControls above is, in practice, always checking an empty list. This is
 * the one enemy-awareness signal that's actually live at that point: don't
 * walk onto a pickup right where something was standing moments ago just
 * because it happens to be out of our fog radius this exact tick.
 */
function recentEnemyNear(gs: import("../gameState").GameState, pos: GridVec, maxAge: number): boolean {
  if (maxAge <= 0) return false;
  return gs.guessedEnemyPositions(maxAge).some((g) => dist(g.position, pos) <= 1.5);
}

/** Same radius survivalBehavior uses to trigger a hazard escape — avoid locking
 * onto a pickup destination that would immediately get us pulled back off it. */
function hazardAdjacent(hazards: GridVec[], pos: GridVec): boolean {
  return hazards.some((h) => chebyshev(pos, h) <= 2);
}

function pickSafe(ctx: DecisionContext, dirs: GridVec[]): GridVec | null {
  for (const d of dirs) {
    if (d[0] === 0 && d[1] === 0) continue;
    const col = ctx.gs.position[0] + d[0];
    const row = ctx.gs.position[1] + d[1];
    if (ctx.gs.isSafeStep(col, row)) return d;
  }
  // Last resort: blend toward zone centre so we never freeze.
  const self = ctx.gs.self;
  if (self) {
    const toCentre = toUnitStep([
      self.zone_center[0] - ctx.gs.position[0],
      self.zone_center[1] - ctx.gs.position[1],
    ]);
    if (toCentre[0] !== 0 || toCentre[1] !== 0) return toCentre;
  }
  return null;
}

/** Guard against zero-vector perpendicular (target directly on same row/col). */
function safePerp(perp: GridVec): GridVec {
  if (perp[0] !== 0 || perp[1] !== 0) return perp;
  return [1, 0]; // fallback: step right
}

/**
 * Compute a flanking position behind the target for dagger backstab.
 * "Behind" = opposite direction of the target's facing, offset 1 tile —
 * `rear_exposed` is a facing-relative read, so facing (known every tick for
 * every visible enemy) is the ground truth, not our own approach angle.
 *
 * The old approach-angle heuristic is kept only as a fallback for a zero
 * facing vector. Used as the primary rule it was self-defeating: the "flank"
 * tile was perpendicular to wherever we currently stood, so arriving at it
 * moved the goalposts and the bot orbited the target indefinitely without
 * ever attacking (0 damage across every simulated daggers round — see
 * docs/audit/pass2-phase2-observations.md). Returns null when we already
 * stand on the behind tile (nothing left to flank — attack).
 *
 * Exported so combat.ts can check how close an in-progress flank is to
 * completion before deciding whether to finish it or attack head-on instead
 * (see combatBehavior's dagger branch) — the two call sites must agree on the
 * same destination tile, not compute it twice with any risk of drifting apart.
 */
export function flankingPosition(me: GridVec, targetPos: GridVec, targetFacing?: GridVec): GridVec | null {
  if (targetFacing && (targetFacing[0] !== 0 || targetFacing[1] !== 0)) {
    const behind: GridVec = [
      targetPos[0] - Math.sign(targetFacing[0]),
      targetPos[1] - Math.sign(targetFacing[1]),
    ];
    if (behind[0] === me[0] && behind[1] === me[1]) return null;
    return behind;
  }
  // Fallback (unknown facing): perpendicular to the current approach angle.
  const dx = me[0] - targetPos[0];
  const dy = me[1] - targetPos[1];
  if (Math.abs(dx) >= Math.abs(dy)) {
    return [targetPos[0], targetPos[1] + (dy >= 0 ? 1 : -1)];
  }
  return [targetPos[0] + (dx >= 0 ? 1 : -1), targetPos[1]];
}
