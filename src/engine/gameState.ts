import type {
  ArenaMapResponse,
  CapturePadState,
  ClientAction,
  ConnectedMsg,
  FlagState,
  GameMode,
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
  WorldVec,
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
  /** Round-relative tick (1 at round start) — round age without bookkeeping. */
  roundTick = 0;
  self: SelfState | null = null;
  entities: NearbyEntity[] = [];
  nearbyMines = 0;
  /** Server navigation hints; populated only when no enemy is in fog. */
  hints: NavHint[] = [];
  lastSeenEnemies: Record<string, { position: GridVec; tick: number }> = {};

  /** True once the server flags sudden death (random tiles become lethal void). */
  suddenDeath = false;
  /** True while the sudden-death stall punisher runs: EVERYONE takes ramping
   * environmental damage until someone deals damage. Passivity is lethal. */
  suddenDeathStall = false;

  /** Active game mode, echoed on every tick ("ffa" until the first tick). */
  gameMode: GameMode = "ffa";
  /** Our server-assigned team in team modes (1, 2, ...); 0 in FFA. */
  myTeam = 0;
  /** Team modes: team number (string key) -> score. Empty in FFA. */
  teamScores: Record<string, number> = {};
  /** CTF: every team flag, global (never fog-limited), WORLD coordinates. */
  flags: FlagState[] = [];

  /** Accumulated instant-death void tiles (sudden death), keyed row*1000+col.
   * The tick's `void_tiles` only lists tiles inside our fog, so we accumulate:
   * void never reverts within a round. */
  private voidTileSet = new Set<number>();

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

  /** Where WE planted mines (believed, from issued actions; capped at 3). */
  private ownMines: { pos: GridVec; ts: number }[] = [];
  /** Coalition allies' broadcast mine tiles — treated as hazards to route around. */
  private allyMines: GridVec[] = [];

  // --- Fog-free global intel (public spectator feed, pushed per tick) --------
  // Bot fog NEVER shows enemy mines — before this, every mine death was a
  // blind one ('?' in causeOfDeath). Absent/stale feed = all three stay empty
  // and the engine behaves exactly as it did fog-only.
  /** Armed enemy mine tiles from the spectator frame (never friendly-owned). */
  private spectatorMines: GridVec[] = [];
  /** Out-of-band hunters: bots whose server-confirmed target is US. */
  private spectatorHunterList: { id: string; pos: GridVec; weapon: Weapon }[] = [];
  /** Aggro graph: botId -> its current target botId (fog-free). */
  private spectatorTargets = new Map<string, string>();

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

  /**
   * Last tick each enemy was seen mid-dodge (is_dodging). Dodge has a 30-tick
   * cooldown, so "dodged recently" ⇒ they CANNOT sidestep again yet — the
   * window where a telegraphed charged shot is safe against demo-bot juking
   * (their anti-charged sidestep is dodge-gated; go-arena demobots source).
   */
  private enemyLastDodgeTick: Record<string, number> = {};

  /** Coalition allies currently reporting LOW HP — assassin bait; targeting
   * pays a peel bonus for enemies hunting them. */
  private protectAllies: Set<string> = new Set();

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
    // Mines don't survive round transitions (everyone respawns on a fresh
    // field); stale beliefs would phantom-block tiles all next round.
    this.ownMines = [];
    this.allyMines = [];
    this.spectatorMines = [];
    this.spectatorHunterList = [];
    this.spectatorTargets.clear();
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
    // Team assignment, flags and void tiles are strictly per-round state
    // (teams re-roll at round start; void only grows within one sudden death).
    this.myTeam = 0;
    this.teamScores = {};
    this.flags = [];
    this.suddenDeathStall = false;
    this.voidTileSet.clear();
    // Everyone's dodge state resets with the round; stale entries would fake
    // "dodge on cooldown" reads next round.
    this.enemyLastDodgeTick = {};
    // Allies respawn at full HP each round — stale low-HP peel flags would
    // misprice targets until the first fresh coop report lands.
    this.protectAllies = new Set();
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

  /**
   * Threat-weighted retreat step: plan a short A* route to the safest tile in
   * the threat window with per-tile danger folded into the step cost, and
   * return the first step as a unit direction. The greedy alternative
   * (ThreatField.safestStep, one-tile gradient descent) stalls at local
   * minima — a wall corner between us and safety reads as "no neighbouring
   * tile improves", and it will happily crawl ALONG an enemy's range ring
   * because each individual step off it looks worse. A weighted path accepts
   * a few locally-worse tiles to reach strictly safer ground.
   *
   * dangerWeight scales how many tiles of detour ~10 danger is worth; <= 0
   * returns null (callers keep their greedy fallback — the knob's off state).
   * Null also when we're already at/near the local safety minimum, so callers
   * fall through to their existing cornered handling unchanged.
   */
  plannedRetreatStep(dangerWeight: number): GridVec | null {
    if (dangerWeight <= 0) return null;
    const me = this.position;
    const field = this.threatField();
    const R = Math.min(this.fogRadius + 3, 14);
    const goal = field.safestTileWithin(me, R, (c, r) => this.isPassable(c, r));
    if (goal[0] === me[0] && goal[1] === me[1]) return null;
    // Only bother when the destination is meaningfully safer than standing
    // still — retreat jitter toward a barely-better tile wastes distance.
    if (field.danger(goal[0], goal[1]) >= field.danger(me[0], me[1]) - 1) return null;
    // Danger outside the computed window is Infinity — treat as a hard wall
    // so the path stays inside the window the goal was chosen from.
    const tileCost = (c: number, r: number): number => {
      const d = field.danger(c, r);
      return Number.isFinite(d) ? (d / 10) * dangerWeight : 10_000;
    };
    // safePassable hard-blocks hazard tiles (mines/burn/void) exactly like
    // every other local route; the weighted cost handles the soft dangers.
    const next =
      nextStep(me, goal, this.gridSize, this.safePassable(goal), tileCost) ??
      nextStep(me, goal, this.gridSize, (c, r) => this.isPassable(c, r), tileCost);
    if (!next) return null;
    const step: GridVec = [next[0] - me[0], next[1] - me[1]];
    // The first step itself must still be steppable this tick (isSafeStep is
    // stricter than safePassable: armed teleport pads, hazard halos).
    if (!this.isSafeStep(next[0], next[1])) return null;
    // Never take a first step that's strictly MORE dangerous than standing
    // still. EQUAL is the planner's whole edge — greedy safestStep demands a
    // strict improvement and stalls on flat plateaus (wall pockets, range-ring
    // crawls), while a route can cross flat ground toward globally safer
    // tiles. But a worse first step means walking INTO coverage (e.g.
    // squeezing past an enemy parked on the zone-return line because the big
    // outside-zone baseline dilutes its marginal cost) — we re-plan every
    // tick, so that "route past the enemy" never actually survives contact.
    // Defer to the greedy/cornered handling instead.
    if (field.danger(next[0], next[1]) > field.danger(me[0], me[1]) + 0.001) return null;
    return step;
  }

  /** Best estimate of our own attack range, preferring the server's value. */
  effectiveAttackRange(): number {
    if (this.confirmedAttackRange !== null) return this.confirmedAttackRange;
    if (this.self) return profileFor(this.self.weapon).baseRange;
    return 1;
  }

  applyTick(msg: TickMsg): void {
    this.tick = msg.tick_number ?? msg.tick;
    this.roundTick = msg.round_tick ?? this.roundTick + 1;
    this.fogRadius = msg.fog_radius ?? this.fogRadius;
    this.self = msg.your_state;
    this.entities = msg.nearby_entities ?? [];
    this.nearbyMines = msg.nearby_mines ?? 0;
    this.hints = msg.hints ?? [];
    this.suddenDeath = msg.sudden_death ?? this.suddenDeath;
    this.suddenDeathStall = msg.sudden_death_stall === true;
    // Game mode + team context (team_battle/ctf): echoed on every tick, so a
    // mid-round (re)connect is immediately mode- and team-aware.
    if (msg.game_mode) this.gameMode = msg.game_mode;
    this.myTeam = msg.your_state.team ?? 0;
    if (msg.team_scores) this.teamScores = msg.team_scores;
    if (msg.flags) this.flags = msg.flags;
    // Void tiles accumulate: the tick only lists the ones inside our fog and
    // void never reverts within a round (cleared on round start / reconnect).
    if (msg.void_tiles) {
      for (const [c, r] of msg.void_tiles) this.voidTileSet.add(r * 1000 + c);
    }
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
      if (enemy.is_dodging) this.enemyLastDodgeTick[enemy.bot_id] = now;
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
      ([, info]) => now - info.tick > 30,
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

  /**
   * Is this bot on our side? Two independent sources, either suffices:
   *  - our own coalition (Redis coop bus, bot_ids we control), and
   *  - the SERVER-assigned team in team_battle/ctf (friendly fire is off, so
   *    attacking a teammate deals zero damage — pure wasted actions, and
   *    projectiles/splash aimed near them are wasted too).
   * In FFA (myTeam 0) the team clause never matches, and the coalition
   * truce-break (setFriendlies(∅)) keeps working: server teams are never
   * "truce-broken" because the server's win condition is per-team.
   */
  isFriendlyBot(b: Pick<NearbyBot, "bot_id" | "team">): boolean {
    if (this.friendlies.has(b.bot_id)) return true;
    return this.myTeam > 0 && (b.team ?? 0) === this.myTeam;
  }

  enemies(): NearbyBot[] {
    return this.entities.filter(
      (e): e is NearbyBot =>
        e.type === "bot" && e.bot_id !== this.selfId && !this.isFriendlyBot(e) && e.is_alive,
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
   * Hazards we should not stand on RIGHT NOW: burn fields, void, mines,
   * gravity wells, and pulsing hazard-zone RECTANGLES. The live wire type is
   * "hazard_zone" with a width×height rect from a top-left `position` (pass-4
   * API audit; the engine previously only matched "hazard", which the server
   * never sends, so it walked through active zones at 3 HP/tick).
   *
   * Pulse awareness: a zone's tiles are dangerous when it's `active` OR about
   * to flip back on (hazardZoneHot); off-phase zones and `active: false`
   * point-hazards are excluded here (crossable this instant) and surfaced via
   * dormantHazardTiles() instead, so routing can cross a dormant pulse zone
   * while the threat field still discourages lingering on it. Zones from the
   * map layout that we can't see live (outside fog) count as always-dangerous:
   * their tick_counter drifts from the static snapshot, so assuming hot is the
   * only safe read, and the rects are small enough that avoiding costs little.
   */
  hazardTiles(): GridVec[] {
    const out: GridVec[] = [];
    const liveZoneIds = new Set<string>();
    for (const e of this.entities) {
      if (e.type === "burn_field" || e.type === "hazard") {
        // Pulsing point-hazards advertise active:false in their off-phase.
        if ((e as { active?: boolean }).active !== false) out.push(e.position);
      } else if (e.type === "hazard_zone") {
        liveZoneIds.add(e.id);
        if (hazardZoneHot(e)) pushZoneTiles(out, e);
      } else if (e.type === "void" || e.type === "mine" || e.type === "gravity_well") {
        // No off-phase for these: void is void, mines don't pulse.
        out.push((e as { position: GridVec }).position);
      }
    }
    // Map-known zones with no live entity this tick (out of fog): assume hot.
    for (const z of this.mapHazardZones) {
      if (!liveZoneIds.has(z.id)) pushZoneTiles(out, z);
    }
    // Coalition allies' broadcast mines are as lethal as our own visible
    // hazards but the server never shows them to us. Folding them in here
    // hard-blocks isSafeStep near them and triggers the step-off-hazard rung
    // — the threat-field +50 alone only DISCOURAGED the tile, and safestStep
    // still picked it when every alternative scored worse (a third coalition
    // kill landed after mine broadcasting went live).
    for (const m of this.allyMines) out.push(m);
    // ENEMY mines from the spectator feed (fog never shows them): same
    // hard-block treatment. These were pure invisible killers before —
    // nothing in the bot protocol ever reveals another bot's armed mine.
    for (const m of this.spectatorMines) out.push(m);
    // Sudden-death void tiles: instant death, no off-phase, only ever grows.
    // (Also blocked outright in isPassable — listing them here additionally
    // feeds the threat field and the isSafeStep halo so we never path-plan
    // ADJACENT to one either.)
    for (const k of this.voidTileSet) out.push([k % 1000, Math.floor(k / 1000)]);
    return out;
  }

  /** Pulsing hazards currently in their off-phase — crossable but not campable. */
  dormantHazardTiles(): GridVec[] {
    const out: GridVec[] = [];
    for (const e of this.entities) {
      if ((e.type === "burn_field" || e.type === "hazard") && (e as { active?: boolean }).active === false) {
        out.push(e.position);
      } else if (e.type === "hazard_zone" && !hazardZoneHot(e)) {
        pushZoneTiles(out, e);
      }
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
   *  '#' wall, 'V' void and '~' water are impassable (bot-setup spec), as are
   *  tiles the live tick reported as sudden-death void (instant death). */
  isPassable(col: number, row: number): boolean {
    if (col < 0 || row < 0 || col >= this.gridSize || row >= this.gridSize) return false;
    if (this.voidTileSet.has(row * 1000 + col)) return false;
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
   * A passability predicate for local A* that ALSO treats hazard tiles (hot
   * zone rects, burn fields, mines, void entities) as blocked. Precomputes the
   * blocked set once per call — hazardTiles() must not run per neighbor probe.
   * The goal tile is never blocked (a goal inside a halo would kill the whole
   * path; the survival rung handles the final approach), and callers must fall
   * back to plain isPassable when no hazard-free path exists.
   */
  private safePassable(goal: GridVec): (c: number, r: number) => boolean {
    const blocked = new Set<number>();
    for (const [c, r] of this.hazardTiles()) blocked.add(r * 1000 + c);
    blocked.delete(goal[1] * 1000 + goal[0]);
    return (c, r) => this.isPassable(c, r) && !blocked.has(r * 1000 + c);
  }

  /**
   * Wall-aware single step toward `goal`. Uses local A* when terrain is loaded
   * so the bot navigates around obstacles rather than bumping into them —
   * preferring a route around known hazard tiles, falling back to walls-only
   * when no hazard-free path exists (pass-4 follow-up: the walls-only planner
   * happily cut straight through hot hazard rects). Falls back to a plain
   * directional step when no terrain is available.
   * Returns a unit direction vector [dc, dr] to pass to move().
   */
  stepToward(goal: GridVec): GridVec {
    const me = this.position;
    if (this.terrain) {
      const next =
        nextStep(me, goal, this.gridSize, this.safePassable(goal)) ??
        nextStep(me, goal, this.gridSize, (c, r) => this.isPassable(c, r));
      if (next) return [next[0] - me[0], next[1] - me[1]] as GridVec;
    }
    return stepToward(me, goal);
  }

  /**
   * Wall-aware single step away from `threat`. Finds the next step toward the
   * point on the opposite side of the grid, using A* when terrain is loaded
   * (hazard-avoiding first, walls-only fallback — same rationale as stepToward).
   * Returns a unit direction vector [dc, dr] to pass to move().
   */
  stepAwayFrom(threat: GridVec): GridVec {
    const me = this.position;
    if (this.terrain) {
      // Goal = mirror of threat through our position, clamped to grid.
      const goalCol = Math.max(0, Math.min(this.gridSize - 1, 2 * me[0] - threat[0]));
      const goalRow = Math.max(0, Math.min(this.gridSize - 1, 2 * me[1] - threat[1]));
      const goal: GridVec = [goalCol, goalRow];
      const next =
        nextStep(me, goal, this.gridSize, this.safePassable(goal)) ??
        nextStep(me, goal, this.gridSize, (c, r) => this.isPassable(c, r));
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

  /**
   * Believed positions of our own live mines (for the coalition broadcast).
   * No age expiry: the spec gives mines no lifetime, so the safe assumption
   * is they persist until the round resets (which clears this list) — a 90s
   * TTL was silently dropping broadcast protection while the mine still sat
   * armed on the field.
   */
  ownMinePositions(): GridVec[] {
    return this.ownMines.map((m) => m.pos);
  }

  /** Replace the coalition allies' broadcast mine tiles. */
  setAllyMines(tiles: GridVec[]): void {
    this.allyMines = tiles;
    // The threat field bakes these in — never serve a cached field built
    // against the old tile set (ordering vs applyTick must not matter).
    this.threatCache = null;
  }

  // (allyMineTiles() was removed: ally mines ride hazardTiles() directly since
  // the hard-block change, which left it with no production consumers.)

  /**
   * Ingest the per-tick fog-free spectator view (or null when the feed is
   * absent/stale/disabled — which clears everything, restoring pure fog-only
   * behaviour). Friendly-owned mines are dropped here: allies broadcast their
   * own over the coop bus (allyMines) and double-counting a tile would double
   * its threat-field cost. Friendly bots never join the hunter/aggro sets.
   */
  setGlobalIntel(intel: { mines: { pos: GridVec; ownerId: string }[]; bots: { id: string; weapon: string; pos: GridVec; hp: number; targetId: string | null; team?: number }[] } | null): void {
    this.spectatorMines = [];
    this.spectatorHunterList = [];
    this.spectatorTargets.clear();
    if (intel) {
      for (const m of intel.mines) {
        if (this.friendlies.has(m.ownerId)) continue;
        this.spectatorMines.push(m.pos);
      }
      for (const b of intel.bots) {
        if (this.isFriendlyBot({ bot_id: b.id, team: b.team })) continue;
        if (!b.targetId) continue;
        this.spectatorTargets.set(b.id, b.targetId);
        if (this.selfId && b.targetId === this.selfId) {
          this.spectatorHunterList.push({ id: b.id, pos: b.pos, weapon: b.weapon as Weapon });
        }
      }
    }
    // Mines ride hazardTiles(), which the threat field bakes in — same
    // ordering rule as setAllyMines: never serve a field built pre-update.
    this.threatCache = null;
  }

  /** Bots server-confirmed locked onto US, including ones beyond our fog. */
  spectatorHunters(): { id: string; pos: GridVec; weapon: Weapon }[] {
    return this.spectatorHunterList;
  }

  /** Fog-free aggro read: who `botId` is targeting, or null if unknown/idle. */
  spectatorTargetOf(botId: string): string | null {
    return this.spectatorTargets.get(botId) ?? null;
  }

  /** Positions of allies (coalition + server teammates) inside our fog. */
  allyTiles(): GridVec[] {
    const out: GridVec[] = [];
    for (const e of this.entities) {
      if (e.type !== "bot") continue;
      const b = e as NearbyBot;
      if (b.is_alive && b.bot_id !== this.selfId && this.isFriendlyBot(b)) out.push(b.position);
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

  /**
   * Does the straight segment from us to `target` pass within ~1 tile of a
   * mine WE know about but the server's pathing won't route around for us —
   * coalition allies' broadcast mines (invisible to everyone but the owner)
   * or enemy mines from the spectator feed (invisible in bot fog entirely)?
   * move_to's server-side A* walks straight through both, so the engine must
   * reroute locally. Straight-line approximation of the server's A* —
   * imperfect, but paths are near-straight in open ground and the reroute
   * re-evaluates every tick.
   */
  knownMineOnPath(target: GridVec): boolean {
    const [ax, ay] = this.position;
    const dx = target[0] - ax;
    const dy = target[1] - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return false;
    for (const mines of [this.allyMines, this.spectatorMines]) {
      for (const m of mines) {
        const u = Math.max(0, Math.min(1, ((m[0] - ax) * dx + (m[1] - ay) * dy) / len2));
        const px = ax + u * dx;
        const py = ay + u * dy;
        if ((m[0] - px) ** 2 + (m[1] - py) ** 2 <= 1.2 * 1.2) return true;
      }
    }
    return false;
  }

  /** Is an ally (coalition or server teammate) within `r` (chebyshev)? Fog-local. */
  allyNear(pos: GridVec, r: number): boolean {
    for (const e of this.entities) {
      if (e.type !== "bot") continue;
      const b = e as NearbyBot;
      if (!b.is_alive || b.bot_id === this.selfId || !this.isFriendlyBot(b)) continue;
      if (Math.max(Math.abs(b.position[0] - pos[0]), Math.abs(b.position[1] - pos[1])) <= r) return true;
    }
    return false;
  }

  // --- CTF (capture the flag) -----------------------------------------------
  // Flags are a GLOBAL objective: every flag's live position/status arrives on
  // every team-mode tick, never fog-limited — but in WORLD coordinates (the
  // one place bot messages use them; ÷ cell_size for grid tiles).

  /** Convert a flag's world position to a clamped, passable-agnostic grid tile. */
  private worldToGrid(p: WorldVec): GridVec {
    const clamp = (n: number): number => Math.max(0, Math.min(this.gridSize - 1, Math.floor(n / this.cellSize)));
    return [clamp(p[0]), clamp(p[1])];
  }

  /** The flag WE are currently carrying, or null. */
  carriedFlag(): FlagState | null {
    if (this.gameMode !== "ctf" || !this.selfId) return null;
    return this.flags.find((f) => f.status === "carried" && f.carrier_id === this.selfId) ?? null;
  }

  /**
   * Where to run while carrying an enemy flag. Scoring requires our OWN flag
   * to be at home: if it is, head for our base (the capture point); if it is
   * NOT at home, head for our flag itself — touching a dropped own flag
   * returns it instantly, and shadowing its carrier is the fastest route to
   * getting it back so our carry can score at all.
   */
  ctfCarryGoal(): GridVec | null {
    if (!this.carriedFlag()) return null;
    const ownFlag = this.flags.find((f) => f.team === this.myTeam);
    if (!ownFlag) return null;
    if (ownFlag.status === "at_base") return this.worldToGrid(ownFlag.base_position);
    return this.worldToGrid(ownFlag.position);
  }

  /**
   * The current CTF objective when we are NOT carrying: return our own
   * dropped flag (touch = instant return), else steal the enemy flag when it
   * is stealable (at base or dropped — "carried" means a teammate has it;
   * an enemy can't carry their own flag). Null in FFA/team_battle, or when
   * there is nothing actionable (e.g. teammate carrying, our flag home).
   */
  ctfObjectiveGoal(): { pos: GridVec; why: "return_own_flag" | "steal_enemy_flag" } | null {
    if (this.gameMode !== "ctf" || this.myTeam <= 0) return null;
    const ownFlag = this.flags.find((f) => f.team === this.myTeam);
    if (ownFlag && ownFlag.status === "dropped") {
      return { pos: this.worldToGrid(ownFlag.position), why: "return_own_flag" };
    }
    const enemyFlag = this.flags.find((f) => f.team !== this.myTeam && f.status !== "carried");
    if (enemyFlag) {
      return { pos: this.worldToGrid(enemyFlag.position), why: "steal_enemy_flag" };
    }
    return null;
  }

  /** Flags with positions converted to grid tiles — for snapshots/prompts. */
  flagsGrid(): { id: string; team: number; position: GridVec; basePosition: GridVec; status: string; carrierId: string }[] {
    return this.flags.map((f) => ({
      id: f.id,
      team: f.team,
      position: this.worldToGrid(f.position),
      basePosition: this.worldToGrid(f.base_position),
      status: f.status,
      carrierId: f.carrier_id,
    }));
  }

  /**
   * Can this enemy plausibly dodge RIGHT NOW? False only while we've seen it
   * dodge within the 30-tick cooldown window. Unknown enemies default to true
   * (assume the sidestep is loaded). Powers bowSmartCharge: a telegraphed
   * charged shot into a ready sidestep is a wasted charge; into a spent one
   * it's free damage.
   */
  enemyDodgeReady(botId: string): boolean {
    const last = this.enemyLastDodgeTick[botId];
    if (last === undefined) return true;
    return this.tick - last >= 30;
  }

  /**
   * How many living enemies are server-confirmed locked onto US right now —
   * fog target_id merged with the spectator aggro graph (fog-free), deduped.
   * 2+ means we're being focused; the demo bots' target picker skips dodging
   * bots entirely, so a dodge then breaks EVERY hunter's lock at once.
   */
  huntersOnUs(): number {
    if (!this.selfId) return 0;
    const ids = new Set<string>();
    for (const e of this.enemies()) {
      if ((e.target_id || this.spectatorTargets.get(e.bot_id)) === this.selfId) ids.add(e.bot_id);
    }
    for (const h of this.spectatorHunterList) ids.add(h.id);
    return ids.size;
  }

  /** Replace the set of low-HP coalition allies to peel for (coop reports). */
  setProtectAllies(ids: Set<string>): void {
    this.protectAllies = ids;
  }

  /** Is this bot_id a low-HP coalition ally worth peeling hunters off? */
  isProtectedAlly(botId: string): boolean {
    return this.protectAllies.has(botId);
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
