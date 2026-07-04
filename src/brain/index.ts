import type { Bus } from "../bus";
import { child } from "../shared/logger";
import { CoopCoordinator } from "./coopCoordinator";
import { llm } from "./llm";
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

  // Boot-time LLM connectivity self-test across the whole provider chain —
  // turns a silent "no LLM calls" into a loud, actionable line (which
  // providers are up vs. bad key vs. proxy/Zscaler).
  void llm.healthCheck().then((r) => {
    if (r.ok) log.info({ providers: llm.providerNames(), detail: r.detail }, "LLM chain reachable ✓ — agents active");
    else
      log.error(
        { providers: llm.providerNames(), detail: r.detail },
        "NO LLM provider reachable — agents fall back to deterministic logic. " +
          "Check GOOGLE_API_KEY / DASHSCOPE_API_KEY / OPENROUTER_API_KEY and proxy allowances.",
      );
  });

  log.info("brain online");
  return {
    async stop() {
      await orchestrator.stop();
    },
  };
}
