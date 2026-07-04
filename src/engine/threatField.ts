import type { GridVec } from "../types/protocol";
import { chebyshev, dist } from "../shared/geometry";
import { profileFor } from "./weapons";
import type { GameState } from "./gameState";

/**
 * A local influence/threat map — the spatial-reasoning layer used by every
 * competitive RTS bot (cf. "Kiting in RTS Games Using Influence Maps").
 *
 * Instead of reasoning about a single enemy at a time, we score every nearby
 * tile by how dangerous it is (enemy weapon coverage + zone + hazards). Movement
 * behaviours then pick the safest tile / lowest-danger gradient rather than a
 * naive "step away from the nearest enemy", which avoids walking out of one
 * enemy's range straight into another's (the classic gank death).
 *
 * Cost-bounded: only a window around us is computed (≈ (2R+1)² cells), rebuilt
 * once per tick and cached, so it stays comfortably inside the 10 Hz budget.
 */
export class ThreatField {
  private constructor(
    private readonly originCol: number,
    private readonly originRow: number,
    private readonly grid: Float32Array,
  ) {}

  static build(gs: GameState): ThreatField {
    const me = gs.position;
    const R = Math.min(gs.fogRadius + 3, 14);
    const originCol = Math.max(0, me[0] - R);
    const originRow = Math.max(0, me[1] - R);
    const maxCol = Math.min(gs.gridSize - 1, me[0] + R);
    const maxRow = Math.min(gs.gridSize - 1, me[1] + R);
    const w = maxCol - originCol + 1;
    const h = maxRow - originRow + 1;
    const grid = new Float32Array(w * h);

    const enemies = gs.enemies();
    const hazards = gs.hazardTiles();
    const dormant = gs.dormantHazardTiles();
    const allyTiles = gs.allyTiles();
    // Residual cost of an off-phase pulse hazard. A module literal like its
    // +50/+60 siblings above: the field builds inside GameState with no
    // EnginePolicy access, and the whole weight set tunes together or not at all.
    const dormantDanger = 12;
    const self = gs.self;
    const zoneCenter = self?.zone_center ?? [50, 50];
    const zoneRadius = self?.zone_radius ?? 50;

    for (let row = originRow; row <= maxRow; row++) {
      for (let col = originCol; col <= maxCol; col++) {
        const cell: GridVec = [col, row];
        let danger = 0;

        // Enemy weapon coverage — danger spikes inside an enemy's attack range,
        // decays smoothly outside it. Weighted by the enemy's threat / DPS.
        for (const e of enemies) {
          const range = e.attack_range || profileFor(e.weapon).baseRange;
          const d = dist(cell, e.position);
          const weight = e.threat_score > 0 ? e.threat_score : profileFor(e.weapon).estDps;
          if (d <= range) danger += weight;
          else danger += weight / (1 + (d - range) * (d - range));
          // Grapple wielders yank from 12 tiles (spec) — far beyond their
          // profile range, so the decay above modeled them as safe at 6-8
          // tiles while they pulled us in at will. #1 killer weapon vs the
          // pass-3 prod fleet (59 deaths). Half-weight band out to yank range:
          // being pulled isn't the hit itself, it's the stun + bruiser
          // adjacency that follows.
          if (e.weapon === "grapple" && d > range && d <= 12) danger += weight * 0.5;
        }

        // Outside the safe zone is a slow death — strong, distance-scaled danger.
        const distToCenter = dist(cell, zoneCenter as GridVec);
        if (distToCenter > zoneRadius) danger += 60 + (distToCenter - zoneRadius) * 4;

        // Hazard tiles (burn / void / mine / gravity well) — lethal to stand on.
        for (const hz of hazards) {
          if (chebyshev(cell, hz) <= 1) danger += 50;
        }

        // (Coalition allies' broadcast mines ride hazardTiles() itself now —
        // they're covered by the hazards loop above, same as visible mines.)

        // Ally repulsion: a mild cost near coalition allies keeps the pack
        // spaced so splash interactions can't form at all. The decision-time
        // splash guard can't stop simultaneous-movement races (two teammate
        // kills landed within 5 minutes of it deploying: both bots stepped
        // into cleave range in the same tick the swing resolved) — spacing
        // fixes the CLASS: cleave arcs, mine walk-ins, and AoE overlap all
        // need packed allies to happen. Mild by design (~1/3 of a hazard):
        // focus-fire still converges, it just approaches from spread angles.
        for (const at of allyTiles) {
          const dAlly = chebyshev(cell, at);
          if (dAlly <= 1) danger += 15;
          else if (dAlly === 2) danger += 5;
        }

        // Dormant (off-phase) pulse hazards: crossable right now, but they
        // WILL re-arm — a residual cost discourages lingering/camping on them
        // without walling off the corridor like the full +50 used to.
        for (const dz of dormant) {
          if (chebyshev(cell, dz) <= 1) danger += dormantDanger;
        }

        grid[(row - originRow) * w + (col - originCol)] = danger;
      }
    }

    const field = new ThreatField(originCol, originRow, grid);
    field.width = w;
    field.height = h;
    return field;
  }

  private width = 0;
  private height = 0;

  /** Danger at a tile; large value for cells outside the computed window. */
  danger(col: number, row: number): number {
    const c = col - this.originCol;
    const r = row - this.originRow;
    if (c < 0 || r < 0 || c >= this.width || r >= this.height) return Number.POSITIVE_INFINITY;
    return this.grid[r * this.width + c]!;
  }

  /**
   * Of the 8 walkable neighbours of `from`, the unit step toward the lowest
   * danger (optionally requiring a strict improvement over standing still).
   */
  safestStep(
    from: GridVec,
    passable: (col: number, row: number) => boolean,
    requireImprovement = false,
  ): GridVec | null {
    let best: GridVec | null = null;
    let bestDanger = requireImprovement ? this.danger(from[0], from[1]) : Number.POSITIVE_INFINITY;
    for (let dc = -1; dc <= 1; dc++) {
      for (let dr = -1; dr <= 1; dr++) {
        if (dc === 0 && dr === 0) continue;
        const col = from[0] + dc;
        const row = from[1] + dr;
        if (!passable(col, row)) continue;
        const dgr = this.danger(col, row);
        if (dgr < bestDanger) {
          bestDanger = dgr;
          best = [dc, dr];
        }
      }
    }
    return best;
  }

  /**
   * The lowest-danger tile within `radius` of `from` that is also passable —
   * a good retreat/reposition destination (a local minimum of the field).
   */
  safestTileWithin(
    from: GridVec,
    radius: number,
    passable: (col: number, row: number) => boolean,
  ): GridVec {
    let best = from;
    let bestDanger = this.danger(from[0], from[1]);
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        const col = from[0] + dc;
        const row = from[1] + dr;
        if (!passable(col, row)) continue;
        const dgr = this.danger(col, row);
        // Prefer lower danger; tie-break toward closer tiles.
        if (dgr < bestDanger - 0.001) {
          bestDanger = dgr;
          best = [col, row];
        }
      }
    }
    return best;
  }
}
