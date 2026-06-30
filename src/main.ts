import { assertConfigForRole, config, llmEnabled, runsBrain, runsEngine } from "./config";
import { getBus } from "./bus";
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
  logger.info(
    { role: config.role, bus: config.bus, busHealthy, llm: llmEnabled },
    "starting AI Battle Arena bot",
  );
  if (config.bus === "redis" && !busHealthy) {
    logger.warn("Redis ping failed — workers will keep retrying in the background");
  }

  const handles: Array<EngineHandle | BrainHandle> = [];

  // Start the Brain first so it's subscribed before the Engine connects and
  // fires its first loadout request.
  if (runsBrain) {
    if (llmEnabled) {
      handles.push(await startBrain(bus));
    } else {
      logger.warn(
        "ROLE includes 'brain' but OPENROUTER_API_KEY is unset — LLM brain disabled; " +
          "the engine will fight on its deterministic strategy.",
      );
    }
  }

  if (runsEngine) {
    handles.push(await startEngine(bus));
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
