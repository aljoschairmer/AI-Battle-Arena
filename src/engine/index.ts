import { config, llmEnabled } from "../config";
import { arenaRest } from "../arena/rest";
import { ArenaSocket } from "../arena/ws";
import { type Bus, Channels, Keys } from "../bus";
import { child } from "../shared/logger";
import type { RoundOutcome } from "../shared/memory";
import type { Directive, LoadoutPlan, LoadoutRequest, RoundContext } from "../types/internal";
import { DEFAULT_DIRECTIVE } from "../types/internal";
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
import { GameState } from "./gameState";
import { chooseFallbackLoadout } from "./loadout";
import { buildSnapshot } from "./telemetry";

const log = child("engine");

// Publish a strategy snapshot to the Brain ~2x/sec. The control loop runs every
// tick (10x/sec) regardless — snapshots are only for the slow LLM layer.
const SNAPSHOT_EVERY_TICKS = 5;

export interface EngineHandle {
  stop(): Promise<void>;
}

export async function startEngine(bus: Bus): Promise<EngineHandle> {
  const gs = new GameState();
  const controller = new Controller();
  const socket = new ArenaSocket(
    config.arena.wsUrl,
    config.arena.apiKey,
    config.arena.wsOrigin,
    config.arena.wsAuth,
  );

  let loadoutSent = false;
  let pendingPlan: LoadoutPlan | null = null;
  let fallbackLoadout = chooseFallbackLoadout({});
  let selectionTimer: NodeJS.Timeout | null = null;
  let directiveVersion = -1;

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
    if (d.version <= directiveVersion) return; // ignore stale / out-of-order
    directiveVersion = d.version;
    controller.setDirective(d);
    log.debug({ posture: d.posture, objective: d.objective, src: d.source }, "directive applied");
  });

  const unsubLoadout = await bus.subscribe<LoadoutPlan>(Channels.loadoutPlan, (plan) => {
    pendingPlan = plan;
    // If we're still inside the selection window, commit the Brain's pick now.
    if (!loadoutSent && socket.isOpen) sendLoadout(plan);
  });

  // Seed directive from the KV mirror so a freshly-started engine isn't blind.
  const seeded = await bus.getKV<Directive>(Keys.currentDirective);
  if (seeded) {
    directiveVersion = seeded.version;
    controller.setDirective(seeded);
  } else {
    controller.setDirective({ ...DEFAULT_DIRECTIVE });
  }

  // --- helpers ---------------------------------------------------------------

  function sendLoadout(sel: { weapon: Weapon; stats: SelectLoadoutMsg["stats"]; fallback_behavior: SelectLoadoutMsg["fallback_behavior"] }): void {
    if (loadoutSent) return;
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
      name: config.arena.botName,
      avatar_color: config.arena.botColor,
      default_loadout: fallbackLoadout,
    };
    try {
      await arenaRest.putConfig(botConfig);
      log.info({ name: config.arena.botName, avatar_color: config.arena.botColor }, "bot config applied");
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
    });

    if (!llmEnabled) {
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

    const [ourStats, arenaStatus] = await Promise.all([
      withTimeout(arenaRest.tryGetBotStats(), 1500),
      withTimeout(arenaRest.tryGetArenaStatus(), 1500),
    ]);

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
      bounties: [],
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
      lobbyWeapons: { ...gs.lobbyWeapons },
      constraints: {
        statBudget: gs.statBudget,
        statMin: gs.statMin,
        statMax: gs.statMax,
        availableWeapons: [] as Weapon[],
      },
    };
    const req: LoadoutRequest = { ts: Date.now(), round, context: ctx, fallback: fallbackLoadout };
    void bus.publish(Channels.loadoutRequest, req);
  }

  async function refreshTerrain(): Promise<void> {
    try {
      const map = await arenaRest.getMap();
      if (map.terrain && map.terrain.length > 0) {
        gs.setTerrain(map.terrain);
        log.debug({ rows: map.terrain.length }, "terrain loaded");
      }
    } catch {
      /* terrain is optional; controller assumes open ground without it */
    }
  }

  // --- socket events ---------------------------------------------------------

  socket.on("connected", (msg: ConnectedMsg) => {
    gs.applyConnected(msg);
    loadoutSent = false;
    confirmedWeapon = null;
    log.info(
      { botId: msg.bot_id, grid: msg.grid_size, weapons: msg.available_weapons.length },
      "connected to arena",
    );
    void configureBot();
    void requestLoadout("", -1);
  });

  socket.on("loadout_confirmed", (msg: LoadoutConfirmedMsg) => {
    gs.setConfirmedAttackRange(msg.computed.attack_range);
    confirmedWeapon = msg.weapon;
    log.info(
      { weapon: msg.weapon, maxHp: msg.computed.max_hp, range: msg.computed.attack_range },
      "loadout confirmed",
    );
  });

  socket.on("lobby", (msg: LobbyMsg) => {
    gs.applyLobby(msg);
    log.debug(
      { connected: msg.bots_connected, needed: msg.bots_needed, weapons: gs.lobbyWeapons },
      "in lobby",
    );
    void refreshTerrain();
    if (!loadoutSent) sendLoadout(pendingPlan ?? fallbackLoadout);
  });

  socket.on("round_start", (msg: RoundStartMsg) => {
    gs.applyRoundStart(msg);
    controller.onRoundStart();
    loadoutSent = false;
    pendingPlan = null;
    resetRoundTracking();
    log.info(
      { round: msg.round_number, modifier: msg.round_modifier, bots: msg.bots_in_round },
      "round start",
    );
    void refreshTerrain();
    void requestLoadout(msg.round_modifier, msg.round_number);
  });

  socket.on("tick", (msg: TickMsg) => {
    gs.applyTick(msg);

    // Track all visible enemy weapons for the round telemetry.
    for (const e of gs.enemies()) {
      roundEnemyWeaponsSeen[e.weapon] = (roundEnemyWeaponsSeen[e.weapon] ?? 0) + 1;
    }

    const action = controller.decide(gs);
    socket.send(action);

    if (llmEnabled && gs.tick % SNAPSHOT_EVERY_TICKS === 0) {
      const snap = buildSnapshot(gs);
      if (snap) void bus.publish(Channels.snapshot, snap);
    }
  });

  socket.on("kill", (msg: KillMsg) => {
    log.info({ victim: msg.victim_name, streak: msg.your_kill_streak }, "KILL");
    // Record what weapon the victim had (best we can do — use last known from entities).
    const victimEntity = gs.entities.find(
      (e) => e.type === "bot" && e.bot_id === msg.victim_id,
    );
    const weapon: Weapon = (victimEntity as { weapon?: Weapon })?.weapon ?? "sword";
    roundWeKilled.push({ botId: msg.victim_id, name: msg.victim_name, weapon });
  });

  socket.on("death", (msg: DeathMsg) => {
    log.info({ by: msg.killer_name, weapon: msg.weapon_used, respawn: msg.respawn }, "died");
    roundKilledBy.push({ botId: msg.killed_by, name: msg.killer_name, weapon: msg.weapon_used });
    if (msg.respawn) gs.isRespawning = true;
  });

  socket.on("respawn", (msg: RespawnMsg) => {
    gs.applyRespawn(msg);
    log.info({ hp: msg.hp }, "respawned");
  });

  socket.on("round_end", (msg: RoundEndMsg) => {
    const ticksSurvived = gs.tick - roundStartTick;
    const won = msg.round_winner === config.arena.botName || msg.round_winner === gs.selfId;
    const hpAtDeath = roundKilledBy.length > 0 ? (gs.self?.hp ?? 0) : 0;

    const outcome: RoundOutcome = {
      round: msg.round_number,
      roundModifier: gs.roundModifier,
      ourWeapon: confirmedWeapon,
      kills: msg.your_stats.kills,
      deaths: msg.your_stats.deaths,
      killedBy: [...roundKilledBy],
      weKilled: [...roundWeKilled],
      enemyWeaponsSeen: { ...roundEnemyWeaponsSeen },
      won,
      ticksSurvived,
      hpAtDeath,
    };

    log.info(
      { round: msg.round_number, winner: msg.round_winner, kills: msg.your_stats.kills, deaths: msg.your_stats.deaths, won },
      "round end",
    );

    if (llmEnabled) {
      void bus.publish(Channels.roundOutcome, outcome);
    }

    // Fetch updated lifetime stats after each round for next loadout request.
    void arenaRest.tryGetBotStats().then((stats) => {
      if (stats) {
        log.info(
          { elo: stats.elo, kd: stats.kd_ratio, wins: stats.round_wins, rounds: stats.rounds_played },
          "updated lifetime stats",
        );
      }
    });
  });

  socket.on("error", (msg) => {
    log.warn({ code: msg.code, message: msg.message, details: msg.details }, "server error");
  });

  socket.on("kick", (msg: KickMsg) => {
    log.warn({ reason: msg.reason }, "kicked by server");
  });

  socket.start();
  log.info("engine started");

  return {
    async stop() {
      if (selectionTimer) clearTimeout(selectionTimer);
      unsubDirective();
      unsubLoadout();
      socket.stop();
      log.info("engine stopped");
    },
  };
}
