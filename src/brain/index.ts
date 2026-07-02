import type { Bus } from "../bus";
import { child } from "../shared/logger";
import { CoopCoordinator } from "./coopCoordinator";
import { openrouter } from "./openrouter";
import { Orchestrator } from "./orchestrator";

const log = child("brain");

export interface BrainHandle {
  stop(): Promise<void>;
}

/**
 * Starts the ONE squad-wide Coordinator brain for the coalition (military
 * tactics: focus-fire + hold/flank/support roles). Callers start this at most
 * once per coalition — pass the GLOBAL (unscoped) bus so it hears every
 * parallel bot's coop reports, not just one bot's own scope.
 */
export async function startCoopCoordinator(bus: Bus): Promise<BrainHandle> {
  const coordinator = new CoopCoordinator(bus);
  await coordinator.start();
  return {
    async stop() {
      await coordinator.stop();
    },
  };
}

export async function startBrain(bus: Bus, opts: { memoryScope?: string } = {}): Promise<BrainHandle> {
  const orchestrator = new Orchestrator(bus, opts);
  await orchestrator.start();

  // Boot-time OpenRouter connectivity self-test — turns a silent "no LLM calls"
  // into a loud, actionable line (bad key vs. proxy/Zscaler vs. all good).
  void openrouter.healthCheck().then((r) => {
    if (r.ok) log.info({ detail: r.detail }, "OpenRouter reachable ✓ — LLM agents active");
    else
      log.error(
        { detail: r.detail },
        "OpenRouter UNREACHABLE — LLM agents will fall back to deterministic logic. " +
          "Check OPENROUTER_API_KEY and that openrouter.ai is allowed through your proxy/Zscaler.",
      );
  });

  log.info("brain online");
  return {
    async stop() {
      await orchestrator.stop();
    },
  };
}
