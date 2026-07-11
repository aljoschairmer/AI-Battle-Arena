import type { EnemySnapshot, GameSnapshot } from "../types/internal";
import type { GridVec } from "../types/protocol";
import { dist } from "../shared/geometry";
import type { GameState } from "./gameState";

/**
 * Build the compact snapshot the Engine publishes to the Brain. Deliberately
 * lossy: the LLM needs the strategic gist (who's around, how hurt, where the
 * zone is going) not the full per-tick firehose.
 */
export function buildSnapshot(gs: GameState): GameSnapshot | null {
  const self = gs.self;
  if (!self) return null;
  const me = gs.position;

  const enemies: EnemySnapshot[] = gs
    .enemies()
    .map((e) => ({
      id: e.bot_id,
      name: e.name,
      weapon: e.weapon,
      hp: e.hp,
      maxHp: e.max_hp,
      position: e.position,
      distance: round1(dist(me, e.position)),
      threatScore: round1(e.threat_score),
      hasLineOfSight: e.has_los,
      canAttack: e.can_attack,
      isStunned: e.is_stunned,
      rearExposed: e.rear_exposed,
      targetId: e.target_id ?? null,
    }))
    .sort((a, b) => b.threatScore - a.threatScore)
    .slice(0, 16);

  const nearbyPickups = gs
    .pickups()
    .map((p) => ({ type: p.pickup_type, position: p.position, distance: round1(dist(me, p.position)) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 12);

  const nearbyHazards = gs.entities
    .filter((e) => e.type !== "bot" && e.type !== "pickup" && e.type !== "bounty_target")
    .map((e) => ({
      type: e.type,
      position: e.position,
      distance: round1(dist(me, e.position)),
      radius: "radius" in e ? e.radius : undefined,
      active: "active" in e ? e.active : undefined,
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 8);

  const nearbyTerrain = gatherNearbyTerrain(gs, me, 7);
  const lastSeenEnemies = gs
    .guessedEnemyPositions(30)
    .sort((a, b) => a.since - b.since)
    .map((entry) => ({ botId: entry.bot_id, position: entry.position, age: entry.since }));

  const recentKills = (self.kill_feed ?? []).slice(-5).map((k) => ({
    killer: k.killer,
    victim: k.victim,
    weapon: k.weapon,
  }));

  return {
    ts: Date.now(),
    round: gs.round,
    tick: gs.tick,
    roundTick: gs.roundTick,
    roundModifier: gs.roundModifier,
    suddenDeath: gs.suddenDeath,
    suddenDeathStall: gs.suddenDeathStall,
    gameMode: gs.gameMode,
    // Team-mode context: omitted entirely in FFA so prompts stay lean.
    ...(gs.myTeam > 0
      ? { myTeam: gs.myTeam, teamScores: gs.teamScores, flags: gs.flagsGrid() }
      : {}),
    bountyBeacon: gs.bountyBeacon,
    self: {
      id: self.bot_id,
      weapon: self.weapon,
      hp: Math.round(self.hp),
      maxHp: self.max_hp,
      position: self.position,
      killStreak: self.kill_streak,
      roundKills: self.round_kills,
      inSafeZone: self.in_safe_zone,
      distanceToZoneEdge: round1(self.distance_to_zone_edge),
      grappleCharges: self.grapple_charges,
      isBountyTarget: gs.isBountyTargetSelf(),
    },
    zone: {
      center: self.zone_center,
      radius: round1(self.zone_radius),
      targetCenter: self.zone_target_center,
      targetRadius: round1(self.zone_target_radius),
    },
    enemies,
    nearbyPickups,
    nearbyHazards,
    nearbyTerrain,
    lastSeenEnemies,
    recentKills,
  };
}

function gatherNearbyTerrain(gs: GameState, me: GridVec, maxDistance: number): { type: "wall" | "void" | "water"; position: GridVec; distance: number }[] {
  if (!gs.terrain) return [];
  const features: { type: "wall" | "void" | "water"; position: GridVec; distance: number }[] = [];
  const [cx, cy] = me;
  const minRow = Math.max(0, cy - maxDistance);
  const maxRow = Math.min(gs.gridSize - 1, cy + maxDistance);
  const minCol = Math.max(0, cx - maxDistance);
  const maxCol = Math.min(gs.gridSize - 1, cx + maxDistance);

  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      const cell = gs.terrain[row]?.[col];
      if (!cell || cell === ".") continue;
      const type = cell === "#" ? "wall" : cell === "V" ? "void" : cell === "~" ? "water" : null;
      if (!type) continue;
      const distance = round1(dist(me, [col, row]));
      features.push({ type, position: [col, row], distance });
    }
  }

  return features.sort((a, b) => a.distance - b.distance).slice(0, 12);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
