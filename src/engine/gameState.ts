import type {
  ConnectedMsg,
  GridVec,
  NearbyBot,
  NearbyBurnField,
  NearbyEntity,
  NearbyPickup,
  RoundStartMsg,
  SelfState,
  TickMsg,
} from "../types/protocol";
import { chebyshev, dist } from "../shared/geometry";
import { profileFor } from "./weapons";

/**
 * The Engine's authoritative world model. Rebuilt cheaply each tick from the
 * latest TickMsg, plus longer-lived facts (arena constraints, terrain for the
 * round). Exposes typed, pre-filtered views so behaviours stay terse.
 *
 * Terrain semantics (from /api/v1/arena/map): row-major `terrain[row][col]`,
 *   '.' ground (walkable), '~' water (walkable, cosmetic),
 *   '#' wall (blocks), 'V' void (impassable).
 */
export class GameState {
  gridSize = 100;
  cellSize = 20;
  fogRadius = 7;
  selfId = "";
  statBudget = 20;
  statMin = 1;
  statMax = 10;

  /** terrain[row][col]; undefined until the round map is loaded. */
  terrain: string[][] | null = null;

  round = -1;
  roundModifier = "";
  tick = 0;
  self: SelfState | null = null;
  entities: NearbyEntity[] = [];
  nearbyMines = 0;

  /** Server-confirmed attack range (tiles), from loadout_confirmed. */
  private confirmedAttackRange: number | null = null;

  applyConnected(msg: ConnectedMsg): void {
    this.selfId = msg.bot_id;
    this.gridSize = msg.grid_size[0] || 100;
    this.cellSize = msg.cell_size || 20;
    this.fogRadius = msg.fog_radius || 7;
    this.statBudget = msg.stat_budget || 20;
    this.statMin = msg.stat_min || 1;
    this.statMax = msg.stat_max || 10;
  }

  applyRoundStart(msg: RoundStartMsg): void {
    this.round = msg.round_number;
    this.roundModifier = msg.round_modifier;
    // Terrain is per-round; invalidate until we (optionally) fetch the new map.
    this.terrain = null;
  }

  setTerrain(terrain: string[][] | null): void {
    this.terrain = terrain && terrain.length > 0 ? terrain : null;
  }

  setConfirmedAttackRange(range: number | null): void {
    this.confirmedAttackRange = range && range > 0 ? range : null;
  }

  /** Best estimate of our own attack range, preferring the server's value. */
  effectiveAttackRange(): number {
    if (this.confirmedAttackRange !== null) return this.confirmedAttackRange;
    if (this.self) return profileFor(this.self.weapon).baseRange;
    return 1;
  }

  applyTick(msg: TickMsg): void {
    this.tick = msg.tick_number ?? msg.tick;
    this.fogRadius = msg.fog_radius ?? this.fogRadius;
    this.self = msg.your_state;
    this.entities = msg.nearby_entities ?? [];
    this.nearbyMines = msg.nearby_mines ?? 0;
  }

  // --- typed views -----------------------------------------------------------

  get position(): GridVec {
    return this.self?.position ?? [0, 0];
  }

  enemies(): NearbyBot[] {
    return this.entities.filter(
      (e): e is NearbyBot => e.type === "bot" && e.bot_id !== this.selfId && e.is_alive,
    );
  }

  pickups(): NearbyPickup[] {
    return this.entities.filter((e): e is NearbyPickup => e.type === "pickup");
  }

  burnFields(): NearbyBurnField[] {
    return this.entities.filter(
      (e): e is NearbyBurnField => e.type === "burn_field" && e.active !== false,
    );
  }

  /** Hazards we should not stand on (burn fields, void, generic hazards, mines). */
  hazardTiles(): GridVec[] {
    const out: GridVec[] = [];
    for (const e of this.entities) {
      if (e.type === "burn_field") {
        out.push(e.position);
      } else if (
        e.type === "hazard" ||
        e.type === "void" ||
        e.type === "mine" ||
        e.type === "gravity_well"
      ) {
        out.push((e as { position: GridVec }).position);
      }
    }
    return out;
  }

  /** Is a grid cell walkable given terrain (if known) and grid bounds? */
  isPassable(col: number, row: number): boolean {
    if (col < 0 || row < 0 || col >= this.gridSize || row >= this.gridSize) return false;
    if (!this.terrain) return true; // no map loaded -> assume open
    const r = this.terrain[row];
    if (!r) return true;
    const cell = r[col];
    if (cell === undefined) return true;
    return cell !== "#" && cell !== "V";
  }

  /** Passability that also avoids transient hazards — used for safe stepping. */
  isSafeStep(col: number, row: number): boolean {
    if (!this.isPassable(col, row)) return false;
    for (const h of this.hazardTiles()) {
      if (chebyshev([col, row], h) <= 1) return false;
    }
    return true;
  }

  /** Closest living enemy, or null. */
  nearestEnemy(): NearbyBot | null {
    const me = this.position;
    let best: NearbyBot | null = null;
    let bestD = Infinity;
    for (const e of this.enemies()) {
      const d = dist(me, e.position);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  hpFraction(): number {
    if (!this.self || this.self.max_hp <= 0) return 1;
    return this.self.hp / this.self.max_hp;
  }
}
