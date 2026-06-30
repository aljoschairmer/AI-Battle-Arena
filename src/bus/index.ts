import { config } from "../config";
import { child } from "../shared/logger";
import { MemoryBus } from "./memory";
import { RedisBus } from "./redis";
import type { Bus } from "./types";

const log = child("bus");

let singleton: Bus | null = null;

/**
 * Returns the process-wide bus. In ROLE=all + BUS=memory the Engine and Brain
 * must share the SAME MemoryBus instance, hence the singleton.
 */
export function getBus(): Bus {
  if (singleton) return singleton;
  if (config.bus === "redis") {
    log.info({ url: redacted(config.redis.url) }, "using Redis bus");
    singleton = new RedisBus(config.redis.url);
  } else {
    log.info("using in-memory bus");
    singleton = new MemoryBus();
  }
  return singleton;
}

function redacted(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return url;
  }
}

export type { Bus };
export { Channels, Keys } from "./channels";
