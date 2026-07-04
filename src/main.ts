import { assertConfigForRole, config, configWarnings, llmEnabled, runsBrain, runsEngine } from "./config";
import { getBus, scoped } from "./bus";
import { startBrain, startCoopCoordinator, type BrainHandle } from "./brain";
import { startEngine, type EngineHandle } from "./engine";
import { dumpKnowledge, restoreKnowledge } from "./shared/knowledge";
import { logger } from "./shared/logger";
import { installFetchProxy } from "./shared/proxy";

// Last-resort safety net: a single unexpected error (a malformed server frame,
// a rejected bus.publish, ...) must never silently kill the whole match. Every
// call site we know of already guards itself, but log-and-continue here beats
// a hard crash (which leaves the bot frozen in the arena until the container
// restarts and reconnects).
process.on("uncaughtException", (err) => {
  logger.error({ err: err.message, stack: err.stack }, "uncaughtException — continuing");
});
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason instanceof Error ? reason.message : String(reason) }, "unhandledRejection — continuing");
});

/**
 * Process entrypoint. ROLE decides which workers run:
 *   ROLE=engine -> real-time combat only (talks to Brain over Redis)
 *   ROLE=brain  -> LLM strategy only      (talks to Engine over Redis)
 *   ROLE=all    -> both in one process    (BUS=memory, great for local dev)
 */
async function main(): Promise<void> {
  assertConfigForRole();
  // Non-fatal config problems (bad BOT_COLOR, duplicate names, misaligned
  // BOT_NAMES/BOT_COLORS, ...) collected at parse time — config.ts can't log.
  for (const w of configWarnings) logger.warn(w);
  // Route fetch through an outbound proxy if one is configured (no-op otherwise).
  installFetchProxy();

  const bus = getBus();
  const busHealthy = await bus.ping();
  // One instance per bot; each gets its own bus scope so N bots run in parallel
  // without their snapshots/directives/policies colliding.
  const bots = config.arena.bots.length > 0 ? config.arena.bots : [{ index: 0, apiKey: "", name: config.arena.botName, color: config.arena.botColor, scope: "" }];
  logger.info(
    { role: config.role, bus: config.bus, busHealthy, llm: llmEnabled, bots: bots.length, names: bots.map((b) => b.name) },
    "starting AI Battle Arena bot",
  );
  if (config.bus === "redis" && !busHealthy) {
    logger.warn("Redis ping failed — workers will keep retrying in the background");
  }
  // Replay the committed knowledge dump (data/knowledge/) BEFORE any brain
  // starts: seeds the KV mirror (learned policies/insights) and the brain
  // memory files, missing-only — live state and local learning always win.
  // A fresh clone/container starts with everything the fleet ever learned.
  const knowledgeScopes = [...new Set(["", ...bots.map((b) => b.scope)])];
  try {
    await restoreKnowledge(bus);
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "knowledge restore failed — starting without seed");
  }

  // Split-deployment trap: bus scopes (bot0:, bot1:, ...) are derived from the
  // key COUNT. A ROLE=brain process whose env lacks the engine process's
  // ARENA_API_KEYS listens on the UNSCOPED channels while the engines publish
  // on bot0:/bot1: — every snapshot/directive silently misses. Nothing crashes;
  // the bots just fight brainless. Surface it loudly at startup.
  if (runsBrain && !runsEngine && config.bus === "redis" && config.arena.bots.length <= 1) {
    logger.warn(
      "ROLE=brain with 0-1 ARENA_API_KEY(S) configured: this brain uses the unscoped bus. " +
        "If the engine process runs MULTIPLE keys (scoped bot0:/bot1: channels), set the same " +
        "ARENA_API_KEYS here or the brain will never hear those engines.",
    );
  }

  const handles: Array<EngineHandle | BrainHandle> = [];

  for (const b of bots) {
    const bbus = scoped(bus, b.scope);
    // Start this bot's Brain first so it's subscribed before its Engine connects
    // and fires the first loadout request.
    if (runsBrain) {
      if (llmEnabled) {
        handles.push(await startBrain(bbus, { memoryScope: b.scope }));
      } else if (b.index === 0) {
        logger.warn(
          "ROLE includes 'brain' but OPENROUTER_API_KEY is unset — LLM brain disabled; " +
            "engines fight on their deterministic strategy.",
        );
      }
    }
    if (runsEngine) {
      handles.push(
        await startEngine(bbus, {
          apiKey: b.apiKey,
          botName: b.name,
          botColor: b.color,
          label: b.name,
          botIndex: b.index,
          fleetSize: bots.length,
          // Coalition comms ride the GLOBAL (unscoped) bus so every parallel bot
          // hears every other; scoped buses would isolate them from each other.
          coopBus: config.coop.enabled ? bus : undefined,
        }),
      );
    }
  }

  // ONE squad-wide Coordinator brain per coalition (not one per bot — a
  // fireteam has one commander). Needs an actual squad (2+ bots) and the LLM
  // brain running; reads/writes the GLOBAL bus so it hears every bot's coop
  // reports regardless of their individual scopes.
  if (runsBrain && llmEnabled && config.coop.enabled && bots.length > 1) {
    handles.push(await startCoopCoordinator(bus));
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    for (const h of handles) {
      try {
        await h.stop();
      } catch (e) {
        logger.warn({ err: (e as Error).message }, "error during shutdown");
      }
    }
    // Snapshot everything learned into the repo dump on every stop — AFTER
    // the handles stopped (orchestrator.stop() flushes brain memory to disk)
    // and BEFORE the bus closes (the KV mirror is still readable). Commit
    // data/knowledge/ to carry the learning to the next clone/container.
    try {
      const dumped = await dumpKnowledge(bus, knowledgeScopes);
      logger.info(dumped, "knowledge dumped to repo");
    } catch (e) {
      logger.warn({ err: (e as Error).message }, "knowledge dump failed — learning stays in logs/ only");
    }
    await bus.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  logger.error({ err: (e as Error).message, stack: (e as Error).stack }, "fatal startup error");
  process.exit(1);
});
