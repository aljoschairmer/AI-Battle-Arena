import { config, llmEnabled } from "../config";
import { arenaRest } from "../arena/rest";
import { ArenaSocket } from "../arena/ws";
import { type Bus, Channels, Keys } from "../bus";
import { child } from "../shared/logger";
import type { Directive, LoadoutPlan, LoadoutRequest, RoundContext } from "../types/internal";
import { DEFAULT_DIRECTIVE } from "../types/internal";
import type {
  ConnectedMsg,
  DeathMsg,
  KickMsg,
  KillMsg,
  LoadoutConfirmedMsg,
  LobbyMsg,
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
      if (selectionTimer) clearTimeout(selectionTimer);
      selectionTimer = null;
      log.info({ weapon: sel.weapon, stats: sel.stats }, "loadout selected");
    }
  }

  function requestLoadout(modifier: string, round: number): void {
    fallbackLoadout = chooseFallbackLoadout({
      availableWeapons: undefined,
      modifier,
      budget: gs.statBudget,
      min: gs.statMin,
      max: gs.statMax,
    });

    if (!llmEnabled) {
      // No Brain — just commit the deterministic pick.
      sendLoadout(fallbackLoadout);
      return;
    }

    const ctx: RoundContext = {
      ts: Date.now(),
      round,
      roundModifier: modifier,
      roundModifierLabel: modifier,
      botsInRound: 0,
      leaderboardTop: [],
      bounties: [],
      constraints: {
        statBudget: gs.statBudget,
        statMin: gs.statMin,
        statMax: gs.statMax,
        availableWeapons: [] as Weapon[],
      },
    };
    const req: LoadoutRequest = { ts: Date.now(), round, context: ctx, fallback: fallbackLoadout };
    void bus.publish(Channels.loadoutRequest, req);

    // If the Brain has already answered, use it; otherwise arm a deadline so we
    // never miss the server's selection window.
    if (pendingPlan) {
      sendLoadout(pendingPlan);
    } else {
      const deadline = 4500; // comfortably inside the ~10s server timeout
      if (selectionTimer) clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        if (!loadoutSent) sendLoadout(pendingPlan ?? fallbackLoadout);
      }, deadline);
    }
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
    log.info(
      { botId: msg.bot_id, grid: msg.grid_size, weapons: msg.available_weapons.length },
      "connected to arena",
    );
    requestLoadout("", -1);
  });

  socket.on("loadout_confirmed", (msg: LoadoutConfirmedMsg) => {
    gs.setConfirmedAttackRange(msg.computed.attack_range);
    log.info(
      { weapon: msg.weapon, maxHp: msg.computed.max_hp, range: msg.computed.attack_range },
      "loadout confirmed",
    );
  });

  socket.on("lobby", (msg: LobbyMsg) => {
    log.debug({ connected: msg.bots_connected, needed: msg.bots_needed }, "in lobby");
    void refreshTerrain();
    // Safety net: if we somehow haven't selected yet, do it now.
    if (!loadoutSent) sendLoadout(pendingPlan ?? fallbackLoadout);
  });

  socket.on("round_start", (msg: RoundStartMsg) => {
    gs.applyRoundStart(msg);
    controller.onRoundStart();
    log.info(
      { round: msg.round_number, modifier: msg.round_modifier, bots: msg.bots_in_round },
      "round start",
    );
    void refreshTerrain();
    if (!loadoutSent) sendLoadout(pendingPlan ?? fallbackLoadout);
  });

  socket.on("tick", (msg: TickMsg) => {
    gs.applyTick(msg);
    const action = controller.decide(gs);
    socket.send(action);

    // Slow lane: feed the Brain a condensed snapshot.
    if (llmEnabled && gs.tick % SNAPSHOT_EVERY_TICKS === 0) {
      const snap = buildSnapshot(gs);
      if (snap) void bus.publish(Channels.snapshot, snap);
    }
  });

  socket.on("kill", (msg: KillMsg) => {
    log.info({ victim: msg.victim_name, streak: msg.your_kill_streak }, "KILL");
  });

  socket.on("death", (msg: DeathMsg) => {
    log.info({ by: msg.killer_name, weapon: msg.weapon_used }, "died");
  });

  socket.on("round_end", (msg: RoundEndMsg) => {
    log.info(
      { round: msg.round_number, winner: msg.round_winner, stats: msg.your_stats },
      "round end",
    );
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
