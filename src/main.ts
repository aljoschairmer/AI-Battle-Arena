import { assertConfigForRole, config, llmEnabled, runsBrain, runsEngine } from "./config";
import { getBus, scoped } from "./bus";
import { startBrain, type BrainHandle } from "./brain";
import { startEngine, type EngineHandle } from "./engine";
import { logger } from "./shared/logger";
import { installFetchProxy } from "./shared/proxy";

/**
 * Process entrypoint. ROLE decides which workers run:
 *   ROLE=engine -> real-time combat only (talks to Brain over Redis)
 *   ROLE=brain  -> LLM strategy only      (talks to Engine over Redis)
 *   ROLE=all    -> both in one process    (BUS=memory, great for local dev)
 */
async function main(): Promise<void> {
  assertConfigForRole();
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

  const handles: Array<EngineHandle | BrainHandle> = [];

  for (const b of bots) {
    const bbus = scoped(bus, b.scope);
    // Start this bot's Brain first so it's subscribed before its Engine connects
    // and fires the first loadout request.
    if (runsBrain) {
      if (llmEnabled) {
        handles.push(await startBrain(bbus));
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
          // Coalition comms ride the GLOBAL (unscoped) bus so every parallel bot
          // hears every other; scoped buses would isolate them from each other.
          coopBus: config.coop.enabled ? bus : undefined,
        }),
      );
    }
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
