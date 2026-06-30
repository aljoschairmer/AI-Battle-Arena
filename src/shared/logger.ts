import { createRequire } from "node:module";
import pino, { type Logger } from "pino";
import { config } from "../config";

/**
 * Single shared pino logger. pino is used deliberately: structured logging with
 * near-zero overhead matters when the engine is firing 10x/second.
 *
 * Pretty logging needs the optional `pino-pretty` transport. It may be absent in
 * a slimmed production image (devDeps pruned), so we (a) only request it when it
 * actually resolves and (b) wrap construction in a try/catch — either way we
 * degrade to plain JSON logging instead of crashing the process on startup.
 */
function prettyResolvable(): boolean {
  try {
    createRequire(import.meta.url).resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

function createLogger(): Logger {
  const baseOpts = { level: config.log.level, base: undefined };

  if (config.log.format === "pretty" && prettyResolvable()) {
    try {
      return pino({
        ...baseOpts,
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname",
            messageFormat: "{component} | {msg}",
          },
        },
      });
    } catch {
      // pino-pretty present but failed to initialise — fall back to JSON.
    }
  }

  return pino(baseOpts);
}

export const logger = createLogger();

export function child(component: string) {
  return logger.child({ component });
}
