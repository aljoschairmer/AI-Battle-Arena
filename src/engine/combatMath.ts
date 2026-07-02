import type { NearbyBot } from "../types/protocol";
import { dist } from "../shared/geometry";
import { profileFor } from "./weapons";
import type { DecisionContext } from "./behaviors/context";

/** Rough incoming DPS from an enemy (we rarely know their exact stats). */
export function enemyDps(e: NearbyBot): number {
  return profileFor(e.weapon).estDps;
}

/**
 * Forward-looking "will I win this trade?" estimate — the cheap combat-sim that
 * strong bots use to decide engage vs. disengage. Returns a value in (-1, 1):
 *   > 0  we expect to kill the target before they (and nearby gankers) kill us
 *   < 0  we lose the exchange — back off
 *
 * Compares our DPS-to-their-HP against their incoming DPS-to-our-HP, discounting
 * incoming damage by our defence and adding the DPS of any other attacker
 * already in range of us (so a 1v2 reads as unfavourable).
 */
export function tradeAdvantage(ctx: DecisionContext, e: NearbyBot): number {
  const gs = ctx.gs;
  const self = gs.self;
  if (!self) return 0;

  const ourDps = Math.max(1, gs.selfDps());
  const defenseRed = gs.selfCombat?.defenseRed ?? 0;

  const me = gs.position;
  let incoming = enemyDps(e);
  const gankRadius = ctx.policy.gankRadius;
  const gankWeight = ctx.policy.gankApproachWeight;
  for (const other of gs.enemies()) {
    if (other.bot_id === e.bot_id) continue;
    const d = dist(me, other.position);
    // In-range attacker: full ganker share (pre-existing behavior, unchanged).
    if (other.can_attack && d <= 5) {
      incoming += enemyDps(other) * 0.8;
      continue;
    }
    // Gank anticipation: a bot that isn't a threat THIS tick still turns the
    // fight into a 2v1 within a few ticks if it's closing on us (or is already
    // on us with its weapon momentarily down). Count a distance-faded share of
    // its DPS so the favorable-1v1-about-to-become-2v1 reads unfavorable EARLY
    // enough to disengage cleanly, not once we're surrounded. Weight 0 restores
    // the old in-band-only behavior.
    if (gankWeight <= 0 || d > gankRadius) continue;
    const cooling = d <= 5; // adjacent but can_attack=false — rejoins in ticks
    const closing = dist(me, gs.predictEnemyPos(other, 5)) < d - 0.5;
    if (!cooling && !closing) continue;
    const fade = d <= 5 ? 1 : (gankRadius - d) / (gankRadius - 5);
    incoming += enemyDps(other) * 0.8 * gankWeight * fade;
  }
  incoming *= 1 - Math.min(0.6, defenseRed);

  const ourTtk = e.hp / ourDps;
  const theirTtk = self.hp / Math.max(1, incoming);
  return (theirTtk - ourTtk) / (theirTtk + ourTtk);
}

/** True when the trade clears the (LLM-tunable) advantage threshold. */
export function shouldEngage(ctx: DecisionContext, e: NearbyBot): boolean {
  return tradeAdvantage(ctx, e) >= ctx.policy.minTradeAdvantage;
}
