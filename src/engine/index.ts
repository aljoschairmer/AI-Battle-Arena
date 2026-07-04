import { config, llmEnabled } from "../config";
import { ArenaRest } from "../arena/rest";
import { ArenaSocket } from "../arena/ws";
import { type Bus, Channels, Keys } from "../bus";
import { child } from "../shared/logger";
import type { RoundOutcome } from "../shared/memory";
import type { Directive, EnginePolicy, LoadoutPlan, LoadoutRequest, RoundContext } from "../types/internal";
import { DEFAULT_DIRECTIVE, DEFAULT_POLICY, isFresher, mergePolicy, parsePolicyOverrides, sanitizePolicy, shouldApplyDirective } from "../types/internal";
import type {
  ConnectedMsg,
  DeathMsg,
  KickMsg,
  KillMsg,
  LoadoutConfirmedMsg,
  LobbyMsg,
  RespawnMsg,
  RoundEndMsg,
  RoundStartMsg,
  SelectLoadoutMsg,
  TickMsg,
  Weapon,
} from "../types/protocol";
import { Controller } from "./controller";
import { Coalition } from "./coop";
import { GameState } from "./gameState";
import { chooseFallbackLoadout } from "./loadout";
import { buildSnapshot } from "./telemetry";
import { telemetry as telemetryLog } from "./telemetryLog";
import { outcomeLog } from "./outcomeLog";

// Publish a strategy snapshot to the Brain ~2x/sec. The control loop runs every
// tick (10x/sec) regardless — snapshots are only for the slow LLM layer.
const SNAPSHOT_EVERY_TICKS = 5;
// Broadcast to the coalition ~2x/sec.
const COOP_EVERY_TICKS = 5;

export interface EngineHandle {
  stop(): Promise<void>;
}

/** Per-bot options; defaults to the primary single-bot config. */
export interface EngineOptions {
  apiKey?: string;
  botName?: string;
  botColor?: string;
  label?: string;
  /** Position in our own fleet (0-based) and fleet size, for draft diversity. */
  botIndex?: number;
  fleetSize?: number;
  /** Global (unscoped) bus for bot-to-bot coalition comms; enables BOT_COOP. */
  coopBus?: Bus;
}

export async function startEngine(bus: Bus, opts: EngineOptions = {}): Promise<EngineHandle> {
  const apiKey = opts.apiKey ?? config.arena.apiKey;
  const botName = opts.botName ?? config.arena.botName;
  const botColor = opts.botColor ?? config.arena.botColor;
  const label = opts.label ?? "";
  const fleetSize = opts.fleetSize ?? 1;
  const fleetIndex = fleetSize > 1 ? (opts.botIndex ?? 0) : null;
  const log = child(label ? `engine:${label}` : "engine");
  // Per-bot REST client (bot/stats + config are key-scoped, so each bot needs
  // its own; public endpoints work regardless).
  const rest = new ArenaRest(config.arena.httpBase, apiKey);

  const gs = new GameState();
  const controller = new Controller();
  const socket = new ArenaSocket(
    config.arena.wsUrl,
    apiKey,
    config.arena.wsOrigin,
    config.arena.wsAuth,
    label,
  );
  // Bot-to-bot coalition (only when a global coop bus was provided).
  const coop = opts.coopBus ? new Coalition(opts.coopBus, () => gs.selfId) : null;

  let loadoutSent = false;
  // The arena locks the loadout once a game/round is active ("Cannot change
  // loadout mid-game"). Loadout is chosen ONCE per connection; this guards
  // against any later send attempt (e.g. a slow Brain reply mid-round).
  let loadoutLocked = false;
  let pendingPlan: LoadoutPlan | null = null;
  let fallbackLoadout = chooseFallbackLoadout({});
  let selectionTimer: NodeJS.Timeout | null = null;
  // Freshness state for directive/policy: version AND ts, so a Brain restart
  // (version counter reset) can't leave this engine deaf forever — see isFresher.
  let directiveVersion = -1;
  let directiveTs = -1;
  let policyVersion = -1;
  let policyTs = -1;
  // Provenance of the active policy, recorded alongside each round outcome so
  // wins/losses can be attributed to the policy variant that produced them.
  let policySource = "default";

  // Whether to publish telemetry (snapshots / loadout requests / round outcomes)
  // to the Brain. CRITICAL: in a split deployment the Engine process has NO
  // OpenRouter key (only the Brain does), so `llmEnabled` is false here — gating
  // on it would silence the Brain entirely. Publish whenever a Brain *could* be
  // listening: any Redis bus (separate Brain process) or an in-process Brain.
  const publishToBrain = config.bus === "redis" || llmEnabled;

  // --- Per-round telemetry accumulator (published to Brain at round_end) ---
  let roundStartTick = 0;
  let confirmedWeapon: Weapon | null = null;
  const roundKilledBy: RoundOutcome["killedBy"] = [];
  const roundWeKilled: RoundOutcome["weKilled"] = [];
  const roundEnemyWeaponsSeen: Partial<Record<Weapon, number>> = {};

  function resetRoundTracking(): void {
    roundStartTick = gs.tick;
    roundKilledBy.length = 0;
    roundWeKilled.length = 0;
    for (const k of Object.keys(roundEnemyWeaponsSeen) as Weapon[]) {
      delete roundEnemyWeaponsSeen[k];
    }
  }

  // --- Brain channel wiring (no-ops harmlessly if the Brain isn't running) ---

  const unsubDirective = await bus.subscribe<Directive>(Channels.directive, (d) => {
    // Stale / out-of-order / wrong-round directives are discarded; a restarted
    // Brain (version reset) is accepted via the newer-ts path.
    if (!shouldApplyDirective({ version: directiveVersion, ts: directiveTs }, d, gs.round)) {
      log.debug(
        { v: d?.version, round: d?.round, currentRound: gs.round, src: d?.source },
        "directive discarded (stale version or stale round)",
      );
      return;
    }
    directiveVersion = d.version;
    directiveTs = d.ts;
    controller.setDirective(d);
    log.debug({ posture: d.posture, objective: d.objective, src: d.source }, "directive applied");
  });

  const unsubLoadout = await bus.subscribe<LoadoutPlan>(Channels.loadoutPlan, (plan) => {
    pendingPlan = plan;
    // If we're still inside the selection window, commit the Brain's pick now.
    if (!loadoutSent && socket.isOpen) sendLoadout(plan);
  });

  // Live behaviour tuning from the LLM Tuner — applied instantly, no restart.
  const unsubPolicy = await bus.subscribe<EnginePolicy>(Channels.policy, (raw) => {
    if (!raw || typeof raw.version !== "number" || typeof raw.ts !== "number") return;
    if (!isFresher({ version: policyVersion, ts: policyTs }, raw)) return; // newest wins
    // Never trust the wire: re-clamp on the consuming side (same clamp table
    // as the Brain's mergePolicy — a raw KV write can't smuggle wild values in).
    const p = sanitizePolicy(raw);
    policyVersion = p.version;
    policyTs = p.ts;
    policySource = p.source ?? "bus";
    controller.setPolicy(p);
    log.info(
      { v: p.version, dodge: p.dodgeEagerness, kite: p.kiteRangeBias, src: p.source, why: p.reasoning },
      "policy applied (live re-tune)",
    );
  });

  // Seed directive/policy from the KV mirror so a freshly-started engine isn't
  // blind. Best-effort: a Redis outage at boot must not kill startup (the bus
  // keeps retrying in the background), so fall back to defaults on any failure.
  let seeded: Directive | null = null;
  let seededPolicy: EnginePolicy | null = null;
  try {
    seeded = await bus.getKV<Directive>(Keys.currentDirective);
    seededPolicy = await bus.getKV<EnginePolicy>(Keys.currentPolicy);
  } catch (e) {
    log.warn({ err: (e as Error).message }, "KV seed read failed — starting on defaults");
  }
  if (seeded) {
    directiveVersion = seeded.version;
    directiveTs = seeded.ts;
    controller.setDirective(seeded);
  } else {
    controller.setDirective({ ...DEFAULT_DIRECTIVE });
  }

  if (seededPolicy) {
    const p = sanitizePolicy(seededPolicy);
    policyVersion = p.version;
    policyTs = p.ts;
    policySource = p.source ?? "seed";
    controller.setPolicy(p);
    log.info({ v: p.version, src: p.source }, "restored tuning policy");
  } else {
    // Operator A/B overrides (ENGINE_POLICY_OVERRIDES JSON): same build, some
    // knobs pinned — clamped by the same mergePolicy table as every other
    // policy source. Only applies when no KV policy was restored; a live
    // Tuner still supersedes it (this is an experiment default, not a lock).
    const overrides = parsePolicyOverrides(process.env.ENGINE_POLICY_OVERRIDES);
    if (overrides) {
      const p = mergePolicy(DEFAULT_POLICY, { ...overrides, source: "env-override" });
      policySource = "env-override";
      controller.setPolicy(p);
      log.info({ overrides: Object.keys(overrides) }, "policy overrides applied from env (A/B)");
    } else {
      if (process.env.ENGINE_POLICY_OVERRIDES) {
        log.warn("ENGINE_POLICY_OVERRIDES set but not a JSON object — ignored, running defaults");
      }
      controller.setPolicy({ ...DEFAULT_POLICY });
    }
  }

  // --- helpers ---------------------------------------------------------------

  function sendLoadout(sel: { weapon: Weapon; stats: SelectLoadoutMsg["stats"]; fallback_behavior: SelectLoadoutMsg["fallback_behavior"] }): void {
    if (loadoutSent || loadoutLocked) return;
    const msg: SelectLoadoutMsg = {
      type: "select_loadout",
      weapon: sel.weapon,
      stats: sel.stats,
      fallback_behavior: sel.fallback_behavior,
    };
    const ok = socket.send(msg);
    if (ok) {
      loadoutSent = true;
      confirmedWeapon = sel.weapon;
      if (selectionTimer) clearTimeout(selectionTimer);
      selectionTimer = null;
      log.info({ weapon: sel.weapon, stats: sel.stats }, "loadout selected");
    }
  }

  async function configureBot(): Promise<void> {
    const botConfig = {
      name: botName,
      avatar_color: botColor,
      default_loadout: fallbackLoadout,
    };
    try {
      await rest.putConfig(botConfig);
      log.info({ name: botName, avatar_color: botColor }, "bot config applied");
    } catch (e) {
      log.warn({ err: (e as Error).message }, "failed to apply bot config");
    }
  }

  async function requestLoadout(modifier: string, round: number): Promise<void> {
    fallbackLoadout = chooseFallbackLoadout({
      availableWeapons: undefined,
      modifier,
      budget: gs.statBudget,
      min: gs.statMin,
      max: gs.statMax,
      lobbyWeapons: gs.lobbyWeapons,
      fleetIndex: fleetIndex ?? undefined,
    });

    if (!publishToBrain) {
      sendLoadout(fallbackLoadout);
      return;
    }

    // Start the fallback timer immediately so the Brain has the full window.
    // The arena server gives ~10s to select; we commit the fallback at 8s if the
    // Brain hasn't replied yet, giving ourselves 2s of buffer.
    if (pendingPlan) {
      sendLoadout(pendingPlan);
      return;
    }
    const deadline = 8000;
    if (selectionTimer) clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      if (!loadoutSent) sendLoadout(pendingPlan ?? fallbackLoadout);
    }, deadline);

    // Fetch our own stats and arena status with a short cap so we don't eat into
    // the Brain's LLM window. Best-effort: null values are fine.
    const withTimeout = <T>(p: Promise<T | null>, ms: number): Promise<T | null> =>
      Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);

    const [ourStats, arenaStatus, bounties] = await Promise.all([
      withTimeout(rest.tryGetBotStats(), 1500),
      withTimeout(rest.tryGetArenaStatus(), 1500),
      withTimeout(rest.tryGetBounties(), 1500),
    ]);

    // Refresh the bounty board into GameState so target scoring can favour
    // the actual bounty carriers this round (targetBountyWeight). Skipped on
    // fetch failure: the previous board (bounties persist until claimed) is
    // better than clearing to nothing.
    if (bounties?.entries) {
      gs.setBounties(bounties.entries.map((b) => ({ botId: b.bot_id ?? null, name: b.name })));
      if (bounties.entries.length > 0) {
        log.info({ bounties: bounties.entries.map((b) => `${b.name}:${b.bounty ?? 0}`) }, "bounty board");
      }
    }

    if (ourStats) {
      log.info(
        { elo: ourStats.elo, kd: ourStats.kd_ratio, wins: ourStats.round_wins, rounds: ourStats.rounds_played },
        "our lifetime stats",
      );
    }

    const ctx: RoundContext = {
      ts: Date.now(),
      round,
      roundModifier: modifier,
      roundModifierLabel: modifier,
      botsInRound: 0,
      leaderboardTop: [],
      bounties: (bounties?.entries ?? []).map((b) => ({
        name: b.name,
        bounty: b.bounty ?? 0,
        botId: b.bot_id ?? null,
      })),
      ourStats: ourStats
        ? {
            elo: ourStats.elo,
            kills: ourStats.kills,
            deaths: ourStats.deaths,
            kd_ratio: ourStats.kd_ratio,
            best_streak: ourStats.best_streak,
            rounds_played: ourStats.rounds_played,
            round_wins: ourStats.round_wins,
          }
        : null,
      arenaBotsConnected: arenaStatus?.bots_connected ?? null,
      fleetIndex,
      fleetSize,
      lobbyWeapons: { ...gs.lobbyWeapons },
      constraints: {
        statBudget: gs.statBudget,
        statMin: gs.statMin,
        statMax: gs.statMax,
        availableWeapons: [] as Weapon[],
      },
    };
    const req: LoadoutRequest = { ts: Date.now(), round, context: ctx, fallback: fallbackLoadout };
    bus.publish(Channels.loadoutRequest, req).catch((e) => log.warn({ err: (e as Error).message }, "loadout request publish failed"));
  }

  async function refreshTerrain(): Promise<void> {
    try {
      const map = await rest.getMap();
      if (map.terrain && map.terrain.length > 0) {
        gs.setTerrain(map.terrain);
        log.debug({ rows: map.terrain.length }, "terrain loaded");
      }
    } catch {
      /* terrain is optional; controller assumes open ground without it */
    }
  }

  // --- socket events ---------------------------------------------------------

  // Every socket handler below runs inside `ws`'s own synchronous event
  // emission. An uncaught throw there — e.g. a malformed/short server frame
  // missing a field our types assume is always present — propagates straight
  // out of `ws` and freezes the engine (the bot then sits frozen in the arena
  // until the container restarts and reconnects; see the identical guard on
  // "tick" below, added after the same failure mode hit that handler). Wrap
  // each one so one bad frame degrades gracefully instead of taking the whole
  // match down.

  socket.on("connected", (msg: ConnectedMsg) => {
    try {
      gs.applyConnected(msg);
      telemetryLog.setBotId(msg.bot_id);
      // Fresh connection = a new selection window opens. Drop any plan from a
      // previous connection — requestLoadout below publishes a fresh request,
      // so the Brain re-decides with current insights instead of us silently
      // replaying a stale pick (the 8s fallback timer still guarantees a send).
      loadoutSent = false;
      loadoutLocked = false;
      confirmedWeapon = null;
      pendingPlan = null;
      log.info(
        { botId: msg.bot_id, grid: msg.grid_size, weapons: msg.available_weapons?.length ?? 0 },
        "connected to arena",
      );
      // Coalition hello: membership normally spreads via tick-driven reports,
      // but ticks don't flow in the lobby — a freshly-started fleet fought the
      // first ~500ms of round 1 with EMPTY friendly sets (teammates were valid
      // targets). Announce ourselves the moment we know our bot_id.
      if (coop && gs.selfId) {
        coop.report({
          ts: Date.now(),
          botId: gs.selfId,
          name: botName,
          weapon: gs.self?.weapon ?? "sword",
          pos: gs.position,
          hp: gs.self?.hp ?? 0,
          enemies: [],
          focusVote: null,
          mines: [],
        });
      }
      void configureBot();
      void requestLoadout("", -1);
    } catch (e) {
      log.error({ err: (e as Error).message, stack: (e as Error).stack }, "connected handling threw — continuing");
    }
  });

  socket.on("loadout_confirmed", (msg: LoadoutConfirmedMsg) => {
    try {
      const computed = msg.computed ?? ({} as LoadoutConfirmedMsg["computed"]);
      gs.setConfirmedAttackRange(computed.attack_range ?? null);
      gs.setSelfCombat({
        weaponDamage: computed.weapon_damage ?? 0,
        attackMult: computed.attack_mult ?? 1,
        cooldownSeconds: computed.cooldown_seconds ?? 1,
        maxHp: computed.max_hp ?? 100,
        defenseRed: computed.defense_red ?? 0,
      });
      confirmedWeapon = msg.weapon;
      // The server has accepted and locked our loadout for this session.
      loadoutLocked = true;
      log.info(
        { weapon: msg.weapon, maxHp: computed.max_hp, range: computed.attack_range },
        "loadout confirmed",
      );
    } catch (e) {
      log.error({ err: (e as Error).message, stack: (e as Error).stack }, "loadout_confirmed handling threw — continuing");
    }
  });

  socket.on("lobby", (msg: LobbyMsg) => {
    try {
      gs.applyLobby(msg);
      log.debug(
        { connected: msg.bots_connected, needed: msg.bots_needed, weapons: gs.lobbyWeapons },
        "in lobby",
      );
      void refreshTerrain();
      if (!loadoutSent) sendLoadout(pendingPlan ?? fallbackLoadout);
    } catch (e) {
      log.error({ err: (e as Error).message, stack: (e as Error).stack }, "lobby handling threw — continuing");
    }
  });

  socket.on("round_start", (msg: RoundStartMsg) => {
    try {
      gs.applyRoundStart(msg);
      controller.onRoundStart();
      resetRoundTracking();
      telemetryLog.setActiveBot(gs.selfId ?? "unknown");
      telemetryLog.roundStart(String(msg.round_number));
      log.info(
        { round: msg.round_number, modifier: msg.round_modifier, bots: msg.bots_in_round },
        "round start",
      );
      void refreshTerrain();
      // NOTE: do NOT re-select the loadout here. The arena locks it once the game
      // is active ("Cannot change loadout mid-game"); loadout is chosen once at
      // connect (using the latest learning insights). The Brain's per-round
      // strategy still updates via snapshots; only the weapon/stats stay fixed.
    } catch (e) {
      log.error({ err: (e as Error).message, stack: (e as Error).stack }, "round_start handling threw — continuing");
    }
  });

  socket.on("tick", (msg: TickMsg) => {
    // A single malformed/unexpected server frame must never take the whole
    // process down mid-match (an uncaught throw here propagates straight out of
    // ws's own event emission and kills the engine — the bot then sits frozen
    // in the arena until the container restarts and reconnects). Degrade to a
    // no-op tick and keep playing instead.
    try {
      gs.applyTick(msg);

      // Track all visible enemy weapons for the round telemetry.
      for (const e of gs.enemies()) {
        roundEnemyWeaponsSeen[e.weapon] = (roundEnemyWeaponsSeen[e.weapon] ?? 0) + 1;
      }

      // Bot-to-bot coalition: exclude allies from targeting, focus-fire a shared
      // enemy, and periodically broadcast what we see. Best-effort and additive —
      // if disabled or peers are silent, the bot fights exactly as before.
      if (coop && gs.selfId) {
        gs.setFriendlies(coop.friendlyIds());
        // Allies' mines are invisible to us server-side; their broadcast
        // tiles become threat-field hazards so we route around them instead
        // of dying to our own squad's area denial.
        gs.setAllyMines(coop.friendlyMines());
        controller.setCoopFocus(coop.focus());
        controller.setCoopRole(coop.role());
        if (gs.tick % COOP_EVERY_TICKS === 0) {
          const seen = gs.enemies().slice(0, 8).map((e) => ({ id: e.bot_id, hp: e.hp, pos: e.position }));
          const focusVote = seen.slice().sort((a, b) => a.hp - b.hp)[0]?.id ?? null;
          coop.report({
            ts: Date.now(),
            botId: gs.selfId,
            name: botName,
            weapon: gs.self?.weapon ?? "sword",
            pos: gs.position,
            hp: gs.self?.hp ?? 0,
            enemies: seen,
            focusVote,
            mines: gs.ownMinePositions(),
          });
        }
      }

      // Route this engine's per-tick telemetry to its own bot channel — three
      // interleaved engines in one process otherwise write into whichever
      // bot's file was opened last.
      telemetryLog.setActiveBot(gs.selfId ?? "unknown");
      let action = controller.decide(gs);
      // Server-pathed moves (move_to) walk straight through invisible ally
      // mines — the server's A* can't know them. When the straight path
      // crosses a broadcast mine tile, reroute with a local threat-aware step
      // (which DOES see them) and let next tick re-plan. This was the residual
      // teammate-kill channel after every attack-side guard: our dominant
      // action type simply never consulted the mine map.
      if (action.action === "move_to" && gs.allyMineOnPath(action.target_position)) {
        const step = gs.threatField().safestStep(gs.position, (c, r) => gs.isSafeStep(c, r), true);
        if (step) action = { type: "action", tick: action.tick, action: "move", direction: step };
      }
      socket.send(action);

      if (publishToBrain && gs.tick % SNAPSHOT_EVERY_TICKS === 0) {
        const snap = buildSnapshot(gs);
        if (snap) bus.publish(Channels.snapshot, snap).catch((e) => log.warn({ err: (e as Error).message }, "snapshot publish failed"));
      }
    } catch (e) {
      log.error({ err: (e as Error).message, stack: (e as Error).stack, tick: gs.tick }, "tick handling threw — sending idle and continuing");
      socket.send({ type: "action", tick: gs.tick, action: "idle" });
    }
  });

  socket.on("kill", (msg: KillMsg) => {
    try {
      log.info({ victim: msg.victim_name, streak: msg.your_kill_streak }, "KILL");
      // Record what weapon the victim had (best we can do — use last known from entities).
      const victimEntity = gs.entities.find(
        (e) => e.type === "bot" && e.bot_id === msg.victim_id,
      );
      const weapon: Weapon = (victimEntity as { weapon?: Weapon })?.weapon ?? "sword";
      roundWeKilled.push({ botId: msg.victim_id, name: msg.victim_name, weapon });
    } catch (e) {
      log.error({ err: (e as Error).message, stack: (e as Error).stack }, "kill handling threw — continuing");
    }
  });

  socket.on("death", (msg: DeathMsg) => {
    try {
      // Live servers populate killed_by (bot id) but often send empty
      // killer_name/weapon_used (observed in the pass-3 baseline: every death
      // frame had by:"" weapon:""). Recover both from the killer's last-known
      // entity so cause-of-death attribution and opponent profiles aren't
      // blank — same best-effort lookup the kill handler uses for victims.
      const killerEntity = gs.entities.find(
        (e) => e.type === "bot" && e.bot_id === msg.killed_by,
      ) as { name?: string; weapon?: Weapon } | undefined;
      const killerName = msg.killer_name || killerEntity?.name || "";
      // "" when neither the frame nor our last-seen entities know the weapon —
      // an honest unknown. (A guessed default here sent the pass-3
      // friendly-fire investigation chasing a phantom sword.)
      const killerWeapon: Weapon | "" = msg.weapon_used || killerEntity?.weapon || "";
      log.info({ by: killerName || msg.killed_by, weapon: killerWeapon, respawn: msg.respawn }, "died");
      roundKilledBy.push({ botId: msg.killed_by, name: killerName, weapon: killerWeapon });
      if (msg.respawn) gs.isRespawning = true;
    } catch (e) {
      log.error({ err: (e as Error).message, stack: (e as Error).stack }, "death handling threw — continuing");
    }
  });

  socket.on("respawn", (msg: RespawnMsg) => {
    try {
      gs.applyRespawn(msg);
      log.info({ hp: msg.hp }, "respawned");
    } catch (e) {
      log.error({ err: (e as Error).message, stack: (e as Error).stack }, "respawn handling threw — continuing");
    }
  });

  socket.on("round_end", (msg: RoundEndMsg) => {
    try {
      // `your_stats` is normally always present, but a bot that was permanently
      // eliminated mid-round (e.g. a sudden-death void kill with `respawn:
      // false`) is exactly the case most likely to get a short/partial final
      // frame from the server — never trust it's there.
      const yourStats = msg.your_stats ?? { kills: 0, deaths: 0, damage: 0 };
      const ticksSurvived = gs.tick - roundStartTick;
      const won = msg.round_winner === botName || msg.round_winner === gs.selfId;
      const hpAtDeath = roundKilledBy.length > 0 ? (gs.self?.hp ?? 0) : 0;
      telemetryLog.setActiveBot(gs.selfId ?? "unknown");
      telemetryLog.roundEnd(String(msg.round_number), won ? "win" : "loss");

      const outcome: RoundOutcome = {
        round: msg.round_number,
        roundModifier: gs.roundModifier,
        ourWeapon: confirmedWeapon,
        kills: yourStats.kills,
        deaths: yourStats.deaths,
        killedBy: [...roundKilledBy],
        weKilled: [...roundWeKilled],
        enemyWeaponsSeen: { ...roundEnemyWeaponsSeen },
        won,
        ticksSurvived,
        hpAtDeath,
      };

      log.info(
        { round: msg.round_number, winner: msg.round_winner, kills: yourStats.kills, deaths: yourStats.deaths, won },
        "round end",
      );

      if (publishToBrain) {
        bus.publish(Channels.roundOutcome, outcome).catch((e) => log.warn({ err: (e as Error).message }, "round outcome publish failed"));
      }

      // Fetch updated lifetime stats after each round, then persist the outcome
      // to the on-disk log. The stats fetch is best-effort with a short cap so
      // the outcome line lands even when the REST API is slow/down; the ~2.5s
      // wait is fine — next_round_in gives us a lobby gap and this is not the
      // tick path.
      const aliveAtEnd = (gs.self?.hp ?? 0) > 0 && !gs.isRespawning;
      void Promise.race([
        rest.tryGetBotStats(),
        new Promise<null>((r) => setTimeout(() => r(null), 2500)),
      ]).then((stats) => {
        if (stats) {
          log.info(
            { elo: stats.elo, kd: stats.kd_ratio, wins: stats.round_wins, rounds: stats.rounds_played },
            "updated lifetime stats",
          );
        }
        outcomeLog.record({
          ...outcome,
          botId: gs.selfId ?? "unknown",
          botName,
          label,
          policyVersion,
          policySource,
          aliveAtEnd,
          ...(stats
            ? { elo: stats.elo, lifetimeRoundWins: stats.round_wins, lifetimeRoundsPlayed: stats.rounds_played }
            : {}),
        });
      });
    } catch (e) {
      log.error({ err: (e as Error).message, stack: (e as Error).stack }, "round_end handling threw — continuing");
    }
  });

  socket.on("error", (msg) => {
    try {
      log.warn({ code: msg.code, message: msg.message, details: msg.details }, "server error");
    } catch (e) {
      log.error({ err: (e as Error).message, stack: (e as Error).stack }, "error handling threw — continuing");
    }
  });

  socket.on("kick", (msg: KickMsg) => {
    try {
      log.warn({ reason: msg.reason }, "kicked by server");
    } catch (e) {
      log.error({ err: (e as Error).message, stack: (e as Error).stack }, "kick handling threw — continuing");
    }
  });

  if (coop) await coop.start();

  socket.start();
  log.info({ publishToBrain, bus: config.bus, coop: coop !== null }, "engine started");

  return {
    async stop() {
      if (selectionTimer) clearTimeout(selectionTimer);
      unsubDirective();
      unsubPolicy();
      unsubLoadout();
      coop?.stop();
      socket.stop();
      log.info("engine stopped");
    },
  };
}
