import type {
  ConnectedMsg,
  GridVec,
  LobbyMsg,
  NearbyBot,
  NavHint,
  NearbyBurnField,
  NearbyEntity,
  NearbyPickup,
  RespawnMsg,
  RoundStartMsg,
  SelfState,
  TickMsg,
  Weapon,
} from "../types/protocol";
import { chebyshev, dist, stepAwayFrom, stepToward } from "../shared/geometry";
import { nextStep } from "./pathfinding";
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
  /** Server navigation hints; populated only when no enemy is in fog. */
  hints: NavHint[] = [];
  lastSeenEnemies: Record<string, { position: GridVec; tick: number }> = {};

  /** Weapons seen on opponents in the pre-round lobby (available before round_start). */
  lobbyWeapons: Partial<Record<Weapon, number>> = {};

  /** True while we are in the post-death wait before a respawn. */
  isRespawning = false;

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
    this.lobbyWeapons = {};
    this.isRespawning = false;
  }

  applyLobby(msg: LobbyMsg): void {
    // Pre-scout opponent weapons before the round begins.
    this.lobbyWeapons = {};
    for (const p of msg.players ?? []) {
      if (p.weapon) {
        this.lobbyWeapons[p.weapon] = (this.lobbyWeapons[p.weapon] ?? 0) + 1;
      }
    }
  }

  applyRoundStart(msg: RoundStartMsg): void {
    this.round = msg.round_number;
    this.roundModifier = msg.round_modifier;
    this.isRespawning = false;
    // Terrain is per-round; invalidate until we (optionally) fetch the new map.
    this.terrain = null;
  }

  applyRespawn(msg: RespawnMsg): void {
    this.isRespawning = false;
    // Update self state with the new position and HP if self exists.
    if (this.self) {
      this.self = { ...this.self, position: msg.position as GridVec, hp: msg.hp, is_alive: true };
    }
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
    this.hints = msg.hints ?? [];
    if (this.self?.is_alive) this.isRespawning = false;
    this.updateSeenEnemies();
  }

  private updateSeenEnemies(): void {
    const now = this.tick;
    for (const enemy of this.enemies()) {
      this.lastSeenEnemies[enemy.bot_id] = { position: enemy.position, tick: now };
    }
    const stale = Object.entries(this.lastSeenEnemies).filter(
      ([id, info]) => now - info.tick > 30,
    );
    for (const [id] of stale) delete this.lastSeenEnemies[id];
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

  /**
   * Wall-aware single step toward `goal`. Uses local A* when terrain is loaded
   * so the bot navigates around obstacles rather than bumping into them. Falls
   * back to a plain directional step when no terrain is available.
   * Returns a unit direction vector [dc, dr] to pass to move().
   */
  stepToward(goal: GridVec): GridVec {
    const me = this.position;
    if (this.terrain) {
      const next = nextStep(me, goal, this.gridSize, (c, r) => this.isPassable(c, r));
      if (next) return [next[0] - me[0], next[1] - me[1]] as GridVec;
    }
    return stepToward(me, goal);
  }

  /**
   * Wall-aware single step away from `threat`. Finds the next step toward the
   * point on the opposite side of the grid, using A* when terrain is loaded.
   * Returns a unit direction vector [dc, dr] to pass to move().
   */
  stepAwayFrom(threat: GridVec): GridVec {
    const me = this.position;
    if (this.terrain) {
      // Goal = mirror of threat through our position, clamped to grid.
      const goalCol = Math.max(0, Math.min(this.gridSize - 1, 2 * me[0] - threat[0]));
      const goalRow = Math.max(0, Math.min(this.gridSize - 1, 2 * me[1] - threat[1]));
      const next = nextStep(me, [goalCol, goalRow], this.gridSize, (c, r) => this.isPassable(c, r));
      if (next) return [next[0] - me[0], next[1] - me[1]] as GridVec;
    }
    return stepAwayFrom(me, threat);
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

  guessedEnemyPositions(maxAge = 30): Array<{ bot_id: string; position: GridVec; since: number }> {
    const now = this.tick;
    return Object.entries(this.lastSeenEnemies)
      .filter(([, info]) => now - info.tick <= maxAge)
      .map(([bot_id, info]) => ({ bot_id, position: info.position, since: now - info.tick }));
  }

  hpFraction(): number {
    if (!this.self || this.self.max_hp <= 0) return 1;
    return this.self.hp / this.self.max_hp;
  }

  /** True if we currently have the hazard key active (suppresses hazard damage). */
  hasHazardKey(): boolean {
    return (this.self?.hazard_key_active ?? false) && (this.self?.hazard_key_ticks ?? 0) > 0;
  }

  /** True if we are currently burning, poisoned, or otherwise DoT'd. */
  hasNegativeEffect(): boolean {
    return (this.self?.effects ?? []).some(
      (e) => e.name === "burn" || e.name === "poison" || e.name === "dot",
    );
  }

  /** Dominant weapon among opponents visible in the lobby (pre-round scout). */
  lobbyDominantWeapon(): Weapon | null {
    let best: Weapon | null = null;
    let bestCount = 0;
    for (const [w, n] of Object.entries(this.lobbyWeapons) as [Weapon, number][]) {
      if (n > bestCount) { bestCount = n; best = w; }
    }
    return best;
  }

  /** Whether a terrain cell is a teleport pad ('T') */
  isTeleportPad(col: number, row: number): boolean {
    return this.terrain?.[row]?.[col] === "T";
  }

  /** Whether a terrain cell is a capture pad ('C') */
  isCapturePad(col: number, row: number): boolean {
    return this.terrain?.[row]?.[col] === "C";
  }

  /** Find the nearest capture pad position within search radius, or null. */
  nearestCapturePad(searchRadius = 20): GridVec | null {
    if (!this.terrain) return null;
    const [cx, cy] = this.position;
    let best: GridVec | null = null;
    let bestDist = Infinity;
    for (let row = Math.max(0, cy - searchRadius); row <= Math.min(this.gridSize - 1, cy + searchRadius); row++) {
      for (let col = Math.max(0, cx - searchRadius); col <= Math.min(this.gridSize - 1, cx + searchRadius); col++) {
        if (this.terrain[row]?.[col] === "C") {
          const d = dist([col, row], this.position);
          if (d < bestDist) { bestDist = d; best = [col, row]; }
        }
      }
    }
    return best;
  }
}
