import pino from "pino";
import { config } from "../config";

/**
 * Single shared pino logger. pino is used deliberately: structured logging with
 * near-zero overhead matters when the engine is firing 10x/second.
 */
const isPretty = config.log.format === "pretty";

export const logger = pino({
  level: config.log.level,
  base: undefined, // drop pid/hostname noise
  ...(isPretty
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname",
            messageFormat: "{component} | {msg}",
          },
        },
      }
    : {}),
});

export function child(component: string) {
  return logger.child({ component });
}
