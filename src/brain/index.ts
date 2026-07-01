import type { Bus } from "../bus";
import { child } from "../shared/logger";
import { openrouter } from "./openrouter";
import { Orchestrator } from "./orchestrator";

const log = child("brain");

export interface BrainHandle {
  stop(): Promise<void>;
}

export async function startBrain(bus: Bus): Promise<BrainHandle> {
  const orchestrator = new Orchestrator(bus);
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
