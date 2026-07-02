/**
 * src/engine/outcomeLog.ts
 *
 * Persistent per-round outcome record — the win-rate ground truth the
 * win-rate pass is measured against. One JSON line per completed round,
 * appended to a single file across sessions (unlike telemetryLog's
 * one-file-per-round tick firehose, this is meant to accumulate), so
 * "what's our win rate over the last N rounds and why did we lose the
 * losses" is answerable from disk at any time:
 *
 *   - outcome (won / lost) and cause of death classified from the real
 *     DeathMsg stream: killed by a bot (who + weapon), an environmental
 *     kill (zone / hazard / void / mine names the server uses), or no
 *     death recorded at all (lost on last-alive without dying = zone
 *     timeout or a death frame we never received)
 *   - the active EnginePolicy version + source and an operator-set
 *     variant label (POLICY_VARIANT env), so outcomes from different
 *     policy variants can be compared in the same file — the lightweight
 *     A/B mechanism for judging every behavior change in this pass
 *   - lifetime ELO / round-wins after the round when the stats fetch
 *     succeeds in time (best-effort, absent otherwise)
 *
 * Design constraints, same as telemetryLog: never on the tick hot path
 * (round_end only), never throws into the engine (append is
 * fire-and-forget with an error latch), multi-bot safe (entries carry
 * botId/label; a single process appends sequentially). Enabled by
 * default — measurement must not depend on remembering an env flag —
 * disable with OUTCOME_LOG=0.
 */

import { appendFile, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RoundOutcome } from "../shared/memory";

export type CauseOfDeath =
  | "won" // last bot standing
  | "bot_kill" // a bot's weapon got the final kill on us
  | "environment" // zone / hazard / void / mine credited by the server
  | "no_death_recorded"; // lost without a death frame (outlived by someone else)

/** Server killer names that mean the environment, not a bot, killed us. */
const ENV_KILLER = /zone|hazard|void|storm|environment|world|arena|sudden/i;

/**
 * Classify why the round ended the way it did from the raw outcome record.
 * Exported for the smoke suite and analyze-outcomes tooling.
 */
export function classifyCauseOfDeath(o: Pick<RoundOutcome, "won" | "killedBy">): CauseOfDeath {
  if (o.won) return "won";
  const last = o.killedBy[o.killedBy.length - 1];
  if (!last) return "no_death_recorded";
  if (ENV_KILLER.test(last.botId) || ENV_KILLER.test(last.name)) return "environment";
  // A death frame with no bot credited at all (empty killed_by) is the
  // environment: zone tick, hazard, void — the server names bots, not walls.
  if (!last.botId && !last.name) return "environment";
  return "bot_kill";
}

export interface OutcomeEntry extends RoundOutcome {
  t: "round_outcome";
  ts: number;
  botId: string;
  botName: string;
  /** Engine label for multi-bot runs ("" for the primary bot). */
  label: string;
  /** Operator-set A/B variant tag (POLICY_VARIANT env), "" if unset. */
  variant: string;
  /** EnginePolicy version active when the round ended (-1 = defaults). */
  policyVersion: number;
  /** Where that policy came from: "default" | "seed" | "tuner" | ... */
  policySource: string;
  causeOfDeath: CauseOfDeath;
  /** Were we still alive when round_end arrived? */
  aliveAtEnd: boolean;
  /** Lifetime stats after this round, when the fetch beat the timeout. */
  elo?: number;
  lifetimeRoundWins?: number;
  lifetimeRoundsPlayed?: number;
}

/** Exported for tests (fresh instance re-reads the env); runtime uses the singleton below. */
export class OutcomeLog {
  private enabled: boolean;
  private readonly path: string;
  private errorLogged = false;

  constructor() {
    this.enabled = process.env.OUTCOME_LOG !== "0";
    const dir = process.env.OUTCOME_LOG_DIR ?? "logs/outcomes";
    this.path = join(dir, "outcomes.jsonl");
    if (this.enabled) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        this.enabled = false;
      }
    }
  }

  get variant(): string {
    return process.env.POLICY_VARIANT ?? "";
  }

  record(entry: Omit<OutcomeEntry, "t" | "ts" | "variant" | "causeOfDeath">): void {
    if (!this.enabled) return;
    const full: OutcomeEntry = {
      t: "round_outcome",
      ts: Date.now(),
      variant: this.variant,
      causeOfDeath: classifyCauseOfDeath(entry),
      ...entry,
    };
    appendFile(this.path, JSON.stringify(full) + "\n", (err) => {
      if (err && !this.errorLogged) {
        this.errorLogged = true;
        // eslint-disable-next-line no-console
        console.error(`outcome log write failed (${err.message}) — outcomes will be missing from ${this.path}`);
      }
    });
  }
}

export const outcomeLog = new OutcomeLog();
