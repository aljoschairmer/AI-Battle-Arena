import type { Bus } from "../bus";
import { child } from "../shared/logger";
import { Orchestrator } from "./orchestrator";

const log = child("brain");

export interface BrainHandle {
  stop(): Promise<void>;
}

export async function startBrain(bus: Bus): Promise<BrainHandle> {
  const orchestrator = new Orchestrator(bus);
  await orchestrator.start();
  log.info("brain online");
  return {
    async stop() {
      await orchestrator.stop();
    },
  };
}
