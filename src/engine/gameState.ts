import type {
  ArenaMapResponse,
  CapturePadState,
  ClientAction,
  ConnectedMsg,
  GridVec,
  HazardZoneState,
  LobbyMsg,
  NearbyBot,
  NavHint,
  NearbyBurnField,
  NearbyCapturePad,
  NearbyEntity,
  NearbyHazardZone,
  NearbyPickup,
  NearbyTeleportPad,
  RespawnMsg,
  RoundStartMsg,
  SelfState,
  TeleportPadState,
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
 *   '.' ground (walkable), 'C' capture pad / 'H' hazard zone / 'T' teleport
 *   pad (all walkable), '#' wall (blocks), 'V' void (impassable), '~' water
 *   (impassable per the bot-setup spec — current live maps don't emit it, but
 *   the spec is explicit: "water (impassable)").
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

  /** True once the server flags sudden death (random tiles become lethal void). */
  suddenDeath = false;

  /**
   * The global bounty beacon: live position of the current bounty target,
   * delivered on every tick regardless of fog (see NearbyBountyTarget). Null
   * when no bounty is active or the beacon points at us.
   */
  bountyBeacon: { botId: string; name: string; position: GridVec } | null = null;

  /** Static per-round objective layout from GET /api/v1/arena/map — available
   * during intermission, before anything enters our fog. Live tick entities
   * (fog-ranged, fresher) override these where present. */
  private mapHazardZones: HazardZoneState[] = [];
  private mapCapturePads: CapturePadState[] = [];
  private mapTeleportPads: TeleportPadState[] = [];

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
   * Believed gravity-well charges — FALLBACK ONLY. The server DOES echo
   * `your_state.gravity_well_charge` on live ticks (pass-4 API audit,
   * 2026-07-02); gravityCharges() prefers that and only falls back to this
   * optimistic count (+1 on use_item of a gravity pickup, -1 on
   * use_gravity_well) when the field is absent from a frame.
   */
  private gravityWellCharges = 0;

  /** Consecutive-tick streak of the dagger flank deferral (orbit terminator). */
  private lastFlankTick = -1000;
  private flankStreak = 0;

  /** Last tick we took damage (any source, incl. attackers outside our fog). */
  private lastDamageTick = -1000;

  /** Bounded capture-pad parking: consecutive stand streak + per-pad ignore. */
  private lastPadStandTick = -1000;
  private padStandStreak = 0;
  private padIgnoreUntil = new Map<string, number>();

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
    this.suddenDeath = false;
    // Terrain AND the objective layout are per-round; invalidate until we
    // (optionally) fetch the new map.
    this.terrain = null;
    this.mapHazardZones = [];
    this.mapCapturePads = [];
    this.mapTeleportPads = [];
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
    this.bountyBeacon = null;
    this.lastSeenEnemies = {};
    this.enemyVel = {};
    this.threatCache = null;
    this.pendingDodge = null;
    this.lastTargetId = null;
    this.lastTargetSwitchTick = -1000;
    this.lastShoveTick = -1000;
    this.gravityWellCharges = 0;
    this.lastFlankTick = -1000;
    this.flankStreak = 0;
    this.lastDamageTick = -1000;
    this.lastPadStandTick = -1000;
    this.padStandStreak = 0;
    this.padIgnoreUntil.clear();
  }

  /**
   * True when we've taken damage within the last `withinTicks` ticks — even
   * from an attacker we can't see (a bow's range 8 exceeds our fog radius 7,
   * so a sniper can be invisible). Downtime behaviors use this to keep moving
   * instead of parking on a pad / ghost position while being shot.
   */
  underRecentFire(withinTicks = 30): boolean {
    return this.tick - this.lastDamageTick <= withinTicks;
  }

  /** Drop a last-seen enemy memory (e.g. we searched its position — nothing there). */
  forgetLastSeen(botId: string): void {
    delete this.lastSeenEnemies[botId];
  }

  /** False while `pad` is on cooldown after we already captured/camped it. */
  padAvailable(pad: GridVec): boolean {
    const until = this.padIgnoreUntil.get(`${pad[0]},${pad[1]}`) ?? -1;
    return this.tick >= until;
  }

  /**
   * Count a consecutive tick standing on `pad`; once we've stood long enough
   * to have captured it (spec: 20 uncontested ticks; we allow a margin),
   * ignore this pad for a while — the owner keeps pulsing rewards without
   * standing there, and parking forever made the bot a stationary free kill
   * (the "stuck in the middle of the map" bug).
   */
  notePadStand(pad: GridVec, tick: number, doneTicks = 30, cooldownTicks = 600): number {
    this.padStandStreak = tick - this.lastPadStandTick <= 1 ? this.padStandStreak + 1 : 1;
    this.lastPadStandTick = tick;
    if (this.padStandStreak >= doneTicks) {
      this.padIgnoreUntil.set(`${pad[0]},${pad[1]}`, tick + cooldownTicks);
      this.padStandStreak = 0;
    }
    return this.padStandStreak;
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

  /** Gravity-well charges: server-echoed count when present, else the local
   *  optimistic count (which drifts if a use_item is dropped/rejected). */
  gravityCharges(): number {
    const echoed = this.self?.gravity_well_charge;
    if (typeof echoed === "number") return echoed;
    return this.gravityWellCharges;
  }

  /** Mines we've placed this round: server-echoed when present (survives
   *  reconnects, immune to rejected placements), else the caller's fallback. */
  minesPlaced(fallback: number): number {
    const echoed = this.self?.mine_count;
    return typeof echoed === "number" ? echoed : fallback;
  }

  /** True when WE carry the arena bounty — every bot sees our live position. */
  isBountyTargetSelf(): boolean {
    return this.self?.is_bounty_target === true;
  }

  /** relay_battery buff active (+1 capture progress/tick while contesting). */
  hasRelayBattery(): boolean {
    return this.self?.relay_battery_active === true && (this.self?.relay_battery_ticks ?? 0) > 0;
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

  /**
   * Ingest the full /api/v1/arena/map response: terrain plus the static
   * objective layout (hazard rects with pulse config, capture pad, teleporter
   * pairs). Pre-generated during intermission, so the engine knows every
   * hazard rectangle before anything enters fog range.
   */
  setMapFeatures(map: ArenaMapResponse): void {
    if (map.terrain && map.terrain.length > 0) this.terrain = map.terrain;
    if (Array.isArray(map.hazard_zones)) this.mapHazardZones = map.hazard_zones;
    if (Array.isArray(map.capture_pads)) this.mapCapturePads = map.capture_pads;
    if (Array.isArray(map.teleport_pads)) this.mapTeleportPads = map.teleport_pads;
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
    this.suddenDeath = msg.sudden_death ?? this.suddenDeath;
    // The modifier is echoed on every tick — a mid-round (re)connect learns it
    // here instead of waiting for the next round_start.
    if (msg.round_modifier) this.roundModifier = msg.round_modifier;
    // Global bounty beacon: live target position, fog-exempt. Ours = no beacon
    // to hunt (is_bounty_target on self covers the defensive read).
    this.bountyBeacon = null;
    for (const e of this.entities) {
      if (e.type === "bounty_target" && e.bot_id && e.bot_id !== this.selfId) {
        this.bountyBeacon = { botId: e.bot_id, name: e.name ?? "", position: e.position };
        break;
      }
    }
    if (this.self?.is_alive) this.isRespawning = false;
    if ((this.self?.hits_received?.length ?? 0) > 0) this.lastDamageTick = this.tick;
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
   * Hazards we should not stand on: burn fields, void, mines, gravity wells,
   * and — the big one — pulsing hazard-zone RECTANGLES. The live wire type is
   * "hazard_zone" with a width×height rect from a top-left `position` (pass-4
   * API audit; the engine previously only matched "hazard", which the server
   * never sends, so it walked through active zones at 3 HP/tick).
   *
   * Zone pulse awareness: a zone's tiles are dangerous when it's `active` OR
   * about to flip back on (tick_counter near the end of its off phase — don't
   * path into a rect that ignites under our feet). Zones from the map layout
   * that we can't see live (outside fog) count as always-dangerous: their
   * tick_counter drifts from the static snapshot, so assuming hot is the only
   * safe read, and the rects are small enough that avoiding them costs little.
   */
  hazardTiles(): GridVec[] {
    const out: GridVec[] = [];
    const liveZoneIds = new Set<string>();
    for (const e of this.entities) {
      if (e.type === "burn_field") {
        out.push(e.position);
      } else if (e.type === "hazard_zone") {
        liveZoneIds.add(e.id);
        if (hazardZoneHot(e)) pushZoneTiles(out, e);
      } else if (
        e.type === "hazard" ||
        e.type === "void" ||
        e.type === "mine" ||
        e.type === "gravity_well"
      ) {
        out.push((e as { position: GridVec }).position);
      }
    }
    // Map-known zones with no live entity this tick (out of fog): assume hot.
    for (const z of this.mapHazardZones) {
      if (!liveZoneIds.has(z.id)) pushZoneTiles(out, z);
    }
    return out;
  }

  /** Live capture-pad state (in fog) merged over the map's static snapshot. */
  capturePads(): CapturePadState[] {
    const live = this.entities.filter(
      (e): e is NearbyCapturePad => e.type === "capture_pad",
    );
    const liveIds = new Set(live.map((p) => p.id));
    return [...live, ...this.mapCapturePads.filter((p) => !liveIds.has(p.id))];
  }

  /** Live teleport-pad state (in fog) merged over the map's static snapshot. */
  teleportPads(): TeleportPadState[] {
    const live = this.entities.filter(
      (e): e is NearbyTeleportPad => e.type === "teleport_pad",
    );
    const liveIds = new Set(live.map((p) => p.id));
    return [...live, ...this.mapTeleportPads.filter((p) => !liveIds.has(p.id))];
  }

  /**
   * A teleport pad that would trigger if we stepped on it. Used by isSafeStep:
   * an ACCIDENTAL teleport mid-fight/mid-retreat hands the enemy a free reset
   * (deliberate teleporter travel would come through an explicit behavior).
   */
  private isArmedTeleportPad(col: number, row: number): boolean {
    if (this.terrain?.[row]?.[col] !== "T") return false;
    // If we know the pad's live state and it's cooling down, it's safe ground.
    for (const p of this.teleportPads()) {
      if (p.position[0] === col && p.position[1] === row) return p.is_ready !== false;
    }
    return true; // unknown state — assume armed
  }

  /** Is a grid cell walkable given terrain (if known) and grid bounds?
   *  '#' wall, 'V' void and '~' water are impassable (bot-setup spec). */
  isPassable(col: number, row: number): boolean {
    if (col < 0 || row < 0 || col >= this.gridSize || row >= this.gridSize) return false;
    if (!this.terrain) return true; // no map loaded -> assume open
    const r = this.terrain[row];
    if (!r) return true;
    const cell = r[col];
    if (cell === undefined) return true;
    return cell !== "#" && cell !== "V" && cell !== "~";
  }

  /** Passability that also avoids transient hazards and armed teleport pads —
   *  used for safe stepping. */
  isSafeStep(col: number, row: number): boolean {
    if (!this.isPassable(col, row)) return false;
    if (this.isArmedTeleportPad(col, row)) return false;
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

  /** Replace the known bounty board (out-of-band REST refresh). */
  setBounties(entries: { botId?: string | null; name?: string | null }[]): void {
    this.bountyIds.clear();
    this.bountyNames.clear();
    for (const e of entries) {
      if (e.botId) this.bountyIds.add(e.botId);
      if (e.name) this.bountyNames.add(e.name);
    }
  }

  /** Does this bot currently carry a bounty? Checks the live tick beacon first
   *  (authoritative — the REST board can be empty while a beacon is active,
   *  pass-4 audit), then the REST board by id, then by name as fallback. */
  isBountyTarget(botId: string, name?: string): boolean {
    if (this.bountyBeacon?.botId === botId) return true;
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

  /** Find the nearest capture pad position within search radius, or null.
   *  Prefers the map's pad list (exact, available pre-round); falls back to a
   *  terrain 'C' scan when the map extras weren't loaded. */
  nearestCapturePad(searchRadius = 20): GridVec | null {
    const pads = this.capturePads();
    if (pads.length > 0) {
      let best: GridVec | null = null;
      let bestDist = Infinity;
      for (const p of pads) {
        const d = dist(p.position, this.position);
        if (d <= searchRadius && d < bestDist) { bestDist = d; best = p.position; }
      }
      return best;
    }
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

  /**
   * The capture pad worth walking to right now, or null — the state-machine
   * read the old terrain-'C' scan couldn't do (pass-4 audit: pads expose
   * owner/contested/cooldown live, and squatting a pad we already own on
   * cooldown, or wading into a contested one, wastes the quiet phase):
   *  - pad ready and uncontested (or we hold the relay battery, which doubles
   *    our progress and justifies contesting) → capture it;
   *  - pad cooling down but OWNED BY US → hold it for the control pulse
   *    (+2 score / 4 shield every 15 ticks) only when the pulse is near;
   *  - otherwise → not worth the walk.
   */
  capturePadGoal(searchRadius = 20): GridVec | null {
    const pads = this.capturePads();
    if (pads.length === 0) return this.nearestCapturePad(searchRadius); // terrain fallback
    let best: GridVec | null = null;
    let bestDist = Infinity;
    for (const p of pads) {
      const d = dist(p.position, this.position);
      if (d > searchRadius || d >= bestDist) continue;
      const contestedByOthers =
        p.is_contested && p.capturing_bot_id !== undefined && p.capturing_bot_id !== this.selfId;
      if (p.is_ready !== false) {
        if (contestedByOthers && !this.hasRelayBattery()) continue;
        bestDist = d;
        best = p.position;
      } else if (p.owner_id === this.selfId && p.next_control_pulse_ticks <= 20) {
        bestDist = d;
        best = p.position;
      }
    }
    return best;
  }
}

// --- hazard-zone geometry helpers -------------------------------------------

/**
 * Is a pulsing zone dangerous to path into right now? Active, or inactive but
 * within a few ticks of re-igniting (tick_counter counts through the current
 * phase; off_ticks is the length of the off phase).
 */
function hazardZoneHot(z: HazardZoneState): boolean {
  if (z.active !== false) return true;
  return z.off_ticks > 0 && z.off_ticks - z.tick_counter <= 3;
}

/** Expand a hazard rect (top-left `position`, width×height) into tiles. */
function pushZoneTiles(out: GridVec[], z: HazardZoneState): void {
  const w = Math.max(1, z.width ?? 1);
  const h = Math.max(1, z.height ?? 1);
  for (let dr = 0; dr < h; dr++) {
    for (let dc = 0; dc < w; dc++) {
      out.push([z.position[0] + dc, z.position[1] + dr]);
    }
  }
}
