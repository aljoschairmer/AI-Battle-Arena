import type {
  ClientAction,
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
import { ThreatField } from "./threatField";

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

  /**
   * Current bounty board (fetched out-of-band by the engine at round
   * boundaries — never on the tick path). Overwritten wholesale on each
   * refresh; deliberately NOT cleared by resetTransientObservations because
   * bounties persist across rounds server-side until claimed.
   */
  private bountyIds = new Set<string>();
  private bountyNames = new Set<string>();

  /** Where WE planted mines (believed, from issued actions; capped at 3). */
  private ownMines: { pos: GridVec; ts: number }[] = [];
  /** Coalition allies' broadcast mine tiles — treated as hazards to route around. */
  private allyMines: GridVec[] = [];

  /** True while we are in the post-death wait before a respawn. */
  isRespawning = false;

  /** Server-confirmed attack range (tiles), from loadout_confirmed. */
  private confirmedAttackRange: number | null = null;

  /** Server-computed combat stats, from loadout_confirmed (null until known). */
  selfCombat: {
    weaponDamage: number;
    attackMult: number;
    cooldownSeconds: number;
    maxHp: number;
    defenseRed: number;
  } | null = null;

  /** Per-enemy velocity estimate [dCol, dRow] per tick, for prediction/leading. */
  private enemyVel: Record<string, GridVec> = {};

  /** Arena bot_ids of our own coalition — never treated as enemies (BOT_COOP). */
  private friendlies: Set<string> = new Set();

  /** Lazily-built, per-tick-cached threat field (see threatField()). */
  private threatCache: { tick: number; field: ThreatField } | null = null;

  /** Last target selected by targeting.ts, for switch-detection telemetry
   *  (Phase 2 audit). Lives here rather than module-level state in
   *  targeting.ts so multiple bot instances in one process don't cross-talk. */
  private lastTargetId: string | null = null;
  private lastTargetSwitchTick = -1000;

  /** Dodge awaiting next-tick resolution (damage-taken), for telemetry only. */
  private pendingDodge: { dodgeId: string; tick: number } | null = null;

  // --- Self-tracked action economy (state the server does NOT echo back) ----
  // Spec (docs/arena-spec.md): shove has a 1.5s cooldown = 15 ticks at 10 Hz.
  // The server rejects a shove inside it, wasting the tick; nothing in
  // SelfState reports it, so we track our own issuance.
  private lastShoveTick = -1000;
  /**
   * Believed gravity-well charges: the spec grants one charge per COLLECTED
   * gravity_well pickup, consumed by use_gravity_well — also never echoed in
   * SelfState. Optimistic bookkeeping: +1 when we issue use_item on a gravity
   * pickup, -1 when we issue use_gravity_well.
   */
  private gravityWellCharges = 0;

  /** Consecutive-tick streak of the dagger flank deferral (orbit terminator). */
  private lastFlankTick = -1000;
  private flankStreak = 0;

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
    // A (re)connect may land us in a different round than the one we
    // disconnected from — everything observed on the old connection is void.
    this.resetTransientObservations();
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
    // Everyone teleports to a fresh spawn at round start, so last-seen
    // positions, velocity estimates and cached entities from the previous
    // round are all wrong now. Worse, if the server's tick counter resets per
    // round, old entries have tick > now and the age-based expiry
    // (now - tick > 30) can NEVER reclaim them — guessedEnemyPositions would
    // then report phantom "recently seen" enemies at last round's coordinates
    // until each bot is re-sighted.
    this.resetTransientObservations();
  }

  /** Clear every per-round observation: entity cache, fog memory, velocities. */
  private resetTransientObservations(): void {
    this.entities = [];
    this.hints = [];
    this.nearbyMines = 0;
    this.lastSeenEnemies = {};
    this.enemyVel = {};
    // Mines don't survive round transitions (everyone respawns on a fresh
    // field); stale beliefs would phantom-block tiles all next round.
    this.ownMines = [];
    this.allyMines = [];
    this.threatCache = null;
    this.pendingDodge = null;
    this.lastTargetId = null;
    this.lastTargetSwitchTick = -1000;
    this.lastShoveTick = -1000;
    this.gravityWellCharges = 0;
    this.lastFlankTick = -1000;
    this.flankStreak = 0;
  }

  /**
   * Count a consecutive tick spent considering the dagger in-range flank
   * deferral; returns the current streak length. A gap (any tick where the
   * deferral wasn't considered — target died, gained rear exposure, left
   * range) resets the streak. combat.ts compares the streak against
   * policy.flankMaxDeferTicks so an unbounded chase of a moving "behind" tile
   * terminates in a head-on attack instead of orbiting forever.
   */
  noteFlankDefer(tick: number): number {
    this.flankStreak = tick - this.lastFlankTick <= 1 ? this.flankStreak + 1 : 1;
    this.lastFlankTick = tick;
    return this.flankStreak;
  }

  /**
   * Record the action the controller actually issued this tick (called once
   * per decide() from its choke point). Maintains the self-tracked action
   * economy above; a no-op for every other action type.
   */
  noteIssuedAction(a: ClientAction): void {
    if (a.action === "shove") {
      this.lastShoveTick = a.tick;
    } else if (a.action === "place_mine") {
      // Believed own-mine positions, broadcast to coalition allies so they
      // can route around them (the server hides mines from non-owners, allies
      // included). Server cap is 3 live mines per bot; oldest belief drops.
      this.ownMines.push({ pos: [...this.position] as GridVec, ts: Date.now() });
      if (this.ownMines.length > 3) this.ownMines.shift();
    } else if (a.action === "use_gravity_well") {
      this.gravityWellCharges = Math.max(0, this.gravityWellCharges - 1);
    } else if (a.action === "use_item") {
      const p = this.pickups().find((x) => x.pickup_id === a.item_id);
      if (p && /gravity/i.test(p.pickup_type)) this.gravityWellCharges += 1;
    }
  }

  /** True when the spec's 1.5s shove cooldown has elapsed since OUR last shove. */
  shoveReady(tick: number): boolean {
    return tick - this.lastShoveTick >= 15;
  }

  /** Gravity-well charges we believe we hold (collected pickups minus spends). */
  gravityCharges(): number {
    return this.gravityWellCharges;
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

  setSelfCombat(c: {
    weaponDamage: number;
    attackMult: number;
    cooldownSeconds: number;
    maxHp: number;
    defenseRed: number;
  }): void {
    this.selfCombat = c;
  }

  /** Our estimated damage-per-second, preferring server-computed stats. */
  selfDps(): number {
    const c = this.selfCombat;
    if (c && c.cooldownSeconds > 0) return (c.weaponDamage * c.attackMult) / c.cooldownSeconds;
    return this.self ? profileFor(this.self.weapon).estDps : 25;
  }

  /** Predict where an enemy will be `ticks` ticks from now, from its velocity. */
  predictEnemyPos(enemy: NearbyBot, ticks: number): GridVec {
    const v = this.enemyVel[enemy.bot_id];
    if (!v) return enemy.position;
    const col = Math.max(0, Math.min(this.gridSize - 1, Math.round(enemy.position[0] + v[0] * ticks)));
    const row = Math.max(0, Math.min(this.gridSize - 1, Math.round(enemy.position[1] + v[1] * ticks)));
    return [col, row];
  }

  /** Per-tick threat/influence field around us (cached for the tick). */
  threatField(): ThreatField {
    if (this.threatCache && this.threatCache.tick === this.tick) return this.threatCache.field;
    const field = ThreatField.build(this);
    this.threatCache = { tick: this.tick, field };
    return field;
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
      const prev = this.lastSeenEnemies[enemy.bot_id];
      if (prev && now > prev.tick) {
        const dt = now - prev.tick;
        // Clamp velocity to ±2 tiles/tick so a fog re-acquisition doesn't produce
        // a wild jump that throws off prediction.
        const vc = Math.max(-2, Math.min(2, (enemy.position[0] - prev.position[0]) / dt));
        const vr = Math.max(-2, Math.min(2, (enemy.position[1] - prev.position[1]) / dt));
        this.enemyVel[enemy.bot_id] = [vc, vr];
      }
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

  /** Update the coalition friendly set (their arena bot_ids). */
  setFriendlies(ids: Set<string>): void {
    this.friendlies = ids;
  }

  enemies(): NearbyBot[] {
    return this.entities.filter(
      (e): e is NearbyBot =>
        e.type === "bot" && e.bot_id !== this.selfId && !this.friendlies.has(e.bot_id) && e.is_alive,
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

  /**
   * Hazards we should not stand on RIGHT NOW (burn fields, void, generic
   * hazards, mines). Pulsing hazards advertise `active: false` during their
   * off-phase — those are excluded here (walkable this instant) and surfaced
   * via dormantHazardTiles() instead, so routing can cross a dormant pulse
   * zone while the threat field still discourages lingering on it. Before
   * this split every hazard was permanently lethal to the model: dormant
   * pulse zones blocked corridors all round (and burn fields ignored the
   * `active` filter that burnFields() already applied).
   */
  hazardTiles(): GridVec[] {
    const out: GridVec[] = [];
    for (const e of this.entities) {
      if (e.type === "burn_field" || e.type === "hazard") {
        if ((e as { active?: boolean }).active !== false) out.push(e.position);
      } else if (e.type === "void" || e.type === "mine" || e.type === "gravity_well") {
        // No off-phase for these: void is void, mines don't pulse.
        out.push((e as { position: GridVec }).position);
      }
    }
    // Coalition allies' broadcast mines are as lethal as our own visible
    // hazards but the server never shows them to us. Folding them in here
    // hard-blocks isSafeStep near them and triggers the step-off-hazard rung
    // — the threat-field +50 alone only DISCOURAGED the tile, and safestStep
    // still picked it when every alternative scored worse (a third coalition
    // kill landed after mine broadcasting went live).
    for (const m of this.allyMines) out.push(m);
    return out;
  }

  /** Pulsing hazards currently in their off-phase — crossable but not campable. */
  dormantHazardTiles(): GridVec[] {
    const out: GridVec[] = [];
    for (const e of this.entities) {
      if ((e.type === "burn_field" || e.type === "hazard") && (e as { active?: boolean }).active === false) {
        out.push(e.position);
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

  /** The target selected as of last tick (read-only peek, no side effect) — used
   *  by selectTarget's switch hysteresis to know what it'd be unseating. */
  currentTargetId(): string | null {
    return this.lastTargetId;
  }

  /**
   * Record the current tick's selected target and report whether it changed
   * from last tick. Telemetry bookkeeping AND the source of truth
   * currentTargetId() reads from — selectTarget's hysteresis (targeting.ts)
   * depends on this being called once per tick with the final decision.
   */
  noteTargetSelection(
    id: string | null,
    tick: number,
  ): { switched: boolean; fromId: string | null; ticksSinceLastSwitch: number } {
    const fromId = this.lastTargetId;
    const switched = id !== fromId;
    const ticksSinceLastSwitch = tick - this.lastTargetSwitchTick;
    if (switched) {
      this.lastTargetId = id;
      this.lastTargetSwitchTick = tick;
    }
    return { switched, fromId, ticksSinceLastSwitch };
  }

  /** Stash a dodge for next-tick damage resolution (telemetry only). */
  notePendingDodge(dodgeId: string, tick: number): void {
    this.pendingDodge = { dodgeId, tick };
  }

  /** Consume the pending dodge (if any) for resolution — one-shot. */
  takePendingDodge(): { dodgeId: string; tick: number } | null {
    const p = this.pendingDodge;
    this.pendingDodge = null;
    return p;
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

  /** Believed positions of our own live mines (for the coalition broadcast). */
  ownMinePositions(maxAgeMs = 90_000): GridVec[] {
    const now = Date.now();
    return this.ownMines.filter((m) => now - m.ts <= maxAgeMs).map((m) => m.pos);
  }

  /** Replace the coalition allies' broadcast mine tiles. */
  setAllyMines(tiles: GridVec[]): void {
    this.allyMines = tiles;
    // The threat field bakes these in — never serve a cached field built
    // against the old tile set (ordering vs applyTick must not matter).
    this.threatCache = null;
  }

  /** Coalition allies' mine tiles — hazards for threat-field routing. */
  allyMineTiles(): GridVec[] {
    return this.allyMines;
  }

  /** Positions of coalition allies currently inside our fog. */
  allyTiles(): GridVec[] {
    const out: GridVec[] = [];
    for (const e of this.entities) {
      if (e.type !== "bot") continue;
      const b = e as NearbyBot;
      if (b.is_alive && this.friendlies.has(b.bot_id)) out.push(b.position);
    }
    return out;
  }

  /**
   * Is a coalition ally standing in the fire lane between us and `target`
   * (within ~0.8 tiles of the segment, strictly between the endpoints)?
   * Projectiles may hit the first bot in the path — never shoot through a
   * teammate.
   */
  allyInFireLane(target: GridVec): boolean {
    const [ax, ay] = this.position;
    const [bx, by] = target;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return false;
    for (const t of this.allyTiles()) {
      const u = ((t[0] - ax) * dx + (t[1] - ay) * dy) / len2;
      if (u <= 0.05 || u >= 0.95) continue; // behind us or at/past the target
      const px = ax + u * dx;
      const py = ay + u * dy;
      const distSq = (t[0] - px) ** 2 + (t[1] - py) ** 2;
      if (distSq <= 0.8 * 0.8) return true;
    }
    return false;
  }

  /** Is a coalition ally within `r` (chebyshev) of the given tile? Fog-local. */
  allyNear(pos: GridVec, r: number): boolean {
    for (const e of this.entities) {
      if (e.type !== "bot") continue;
      const b = e as NearbyBot;
      if (!b.is_alive || !this.friendlies.has(b.bot_id)) continue;
      if (Math.max(Math.abs(b.position[0] - pos[0]), Math.abs(b.position[1] - pos[1])) <= r) return true;
    }
    return false;
  }

  /** Replace the known bounty board (out-of-band REST refresh). */
  setBounties(entries: { botId?: string | null; name?: string | null }[]): void {
    this.bountyIds.clear();
    this.bountyNames.clear();
    for (const e of entries) {
      if (e.botId) this.bountyIds.add(e.botId);
      if (e.name) this.bountyNames.add(e.name);
    }
  }

  /** Does this bot currently carry a bounty (by id, or name as fallback)? */
  isBountyTarget(botId: string, name?: string): boolean {
    if (this.bountyIds.has(botId)) return true;
    return name !== undefined && name !== "" && this.bountyNames.has(name);
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
