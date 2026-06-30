import type { EnemySnapshot, GameSnapshot } from "../types/internal";
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
    }))
    .sort((a, b) => b.threatScore - a.threatScore)
    .slice(0, 8);

  const nearbyPickups = gs
    .pickups()
    .map((p) => ({ type: p.pickup_type, position: p.position, distance: round1(dist(me, p.position)) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 6);

  const recentKills = self.kill_feed.slice(-5).map((k) => ({
    killer: k.killer,
    victim: k.victim,
    weapon: k.weapon,
  }));

  return {
    ts: Date.now(),
    round: gs.round,
    tick: gs.tick,
    roundModifier: gs.roundModifier,
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
    },
    zone: {
      center: self.zone_center,
      radius: round1(self.zone_radius),
      targetCenter: self.zone_target_center,
      targetRadius: round1(self.zone_target_radius),
    },
    enemies,
    nearbyPickups,
    recentKills,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
