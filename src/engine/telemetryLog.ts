/**
 * src/engine/telemetryLog.ts
 *
 * Lightweight, non-blocking JSONL event sink for the Phase 2 audit
 * (see engine-behavior-audit-prompt.md). Purpose: capture enough
 * ground truth per round to answer, after the fact, without re-reading
 * code:
 *
 *   - which controller priority claimed each tick, and why higher
 *     ones fell through
 *   - how often the target switches, and whether it thrashes
 *   - what combatMath predicted for an engagement vs. what happened
 *   - whether threat-field-guided dodges actually avoided damage
 *
 * Design constraints (hot path is 10Hz / <1ms budget):
 *   - No sync fs calls in the tick path. All writes go through a
 *     Node stream with backpressure handled by an in-memory ring
 *     buffer; if the buffer fills we drop oldest events rather than
 *     block or grow unbounded.
 *   - No JSON.stringify of large objects — callers pass already-small
 *     primitive/flat payloads. Keep behaviors.ts call sites to a
 *     single flat object literal, no nested game-state dumps.
 *   - Fully optional: if `TELEMETRY_LOG=1` isn't set, every method is
 *     a no-op (checked once, not per-call overhead beyond a boolean).
 *   - One file per round so analysis can be run per-fight or batched
 *     across a session directory.
 *
 * Wiring (as actually implemented — see the audit's Phase 1 trace for
 * why a couple of these deviate from the naive per-file guess):
 *   - controller.ts: `telemetry.tickDecision(...)` is called once per
 *     tick, inline at each of the 9 priority-cascade exit points in
 *     `decide()`, with a `fellThrough` array accumulated as rungs are
 *     passed over. `PriorityName` has two extra members beyond the
 *     audit brief's 6-step summary (`cant_act`, `gravity_well`)
 *     because the real pipeline has 9 rungs, not 6 — see
 *     docs/audit/phase1-behavior-trace.md.
 *   - targeting.ts: `telemetry.targetSwitch(...)` fires only on an
 *     actual change of target id. Since `selectTarget` was previously
 *     a stateless pure function (no prior-tick memory at all — that's
 *     itself a Phase 1 finding), the previous-target id is now
 *     tracked on `GameState` (`noteTargetSelection`), not module-level
 *     state, so multiple bot instances in one process don't cross-talk.
 *   - controller.ts (NOT combat.ts): `telemetry.tradeEvaluated(...)`
 *     is called at the one place `combatMath.tradeAdvantage` is ever
 *     consulted for an engage/disengage decision — inside `decide()`'s
 *     engage-target branch. combat.ts never imports combatMath.ts.
 *     Trade advantage is now computed for every engagement (not just
 *     the previous hp<0.6-gated disengage check) so the "engaged
 *     despite predicted disadvantage" analysis is meaningful for
 *     healthy-bot engagements too.
 *   - survival.ts: `emergencyDodge` calls `telemetry.dodgeDecision(...)`
 *     and stashes the dodge on `GameState` (`notePendingDodge`) when it
 *     fires. Resolution (`telemetry.dodgeResolved(...)`) is called from
 *     `Controller.decide()` itself, before the can't-act guard — not
 *     nested inside `survivalBehavior` — because a dodge that gets the
 *     bot killed or stunned on the very next tick would otherwise never
 *     be resolved (the can't-act guard preempts survivalBehavior on
 *     exactly that tick).
 *   - engine/index.ts: `telemetry.setBotId(...)` on `connected`;
 *     `telemetry.roundStart(...)` / `telemetry.roundEnd(...)` on the
 *     corresponding bus events, bounding each JSONL file to one round.
 */

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";

// ---- Event shapes -----------------------------------------------------
// Keep these flat. Anything you need for analysis, put it here now —
// adding a field later means re-running fights, which is expensive.

export interface TickDecisionEvent {
  t: "tick_decision";
  tick: number;
  ts: number;
  priority: PriorityName;
  /** priorities that were evaluated and fell through, in order */
  fellThrough: PriorityName[];
  /** why the winning priority claimed the tick, e.g. "hp<retreatThreshold" */
  reason: string;
  hp: number;
  maxHp: number;
  posX: number;
  posY: number;
}

export type PriorityName =
  | "cant_act"
  | "survive_zone_hazards"
  | "emergency_dodge"
  | "ctf_objective"
  | "retreat_heal_mine"
  | "gravity_well"
  | "engage_target"
  | "grab_pickups"
  | "hold_ground_zone";

export interface TargetSwitchEvent {
  t: "target_switch";
  tick: number;
  ts: number;
  fromTargetId: string | null;
  toTargetId: string | null;
  /** ticks since the previous switch, for thrash detection */
  ticksSinceLastSwitch: number;
  reason: string;
}

export interface TradeEvaluatedEvent {
  t: "trade_evaluated";
  tick: number;
  ts: number;
  targetId: string;
  /** combatMath's estimate: >0 favors us, <0 favors them */
  predictedAdvantage: number;
  decision: "engage" | "disengage" | "hold";
  ourEffectiveHp: number;
  theirEffectiveHp: number;
  nearbyEnemyCount: number;
}

export interface DodgeDecisionEvent {
  t: "dodge_decision";
  tick: number;
  ts: number;
  dodgeId: string; // correlate with resolution
  chosenTileDanger: number; // threatField value at chosen tile
  minAvailableDanger: number; // lowest danger among candidate tiles
  candidateTileCount: number;
}

export interface DodgeResolvedEvent {
  t: "dodge_resolved";
  tick: number;
  ts: number;
  dodgeId: string;
  damageTaken: number; // 0 if dodge succeeded
}

/**
 * Every action the controller actually issues (one per decision tick), logged
 * at the single choke point in Controller.decide(). Second-pass audit: lets
 * the analyzer count action-economy violations the server would reject —
 * shove re-issued inside its 1.5s cooldown, use_gravity_well spam with no
 * collected charge — which tick_decision's priority names can't see.
 */
export interface ActionIssuedEvent {
  t: "action_issued";
  tick: number;
  ts: number;
  action: string;
}

export interface RoundBoundaryEvent {
  t: "round_start" | "round_end";
  ts: number;
  roundId: string;
  botId: string;
  outcome?: "win" | "loss" | "unknown"; // only on round_end
}

export type TelemetryEvent =
  | TickDecisionEvent
  | TargetSwitchEvent
  | TradeEvaluatedEvent
  | DodgeDecisionEvent
  | DodgeResolvedEvent
  | ActionIssuedEvent
  | RoundBoundaryEvent;

// ---- Sink ---------------------------------------------------------------

const RING_BUFFER_MAX = 2048;

/** Per-bot sink state — multi-bot fleets write one file per bot per round. */
interface BotChannel {
  stream: WriteStream | null;
  ring: string[];
  droppedCount: number;
}

/** Exported for tests (fresh instance re-reads the env); runtime uses the singleton below. */
export class TelemetryLog {
  private enabled: boolean;
  private logDir: string;
  /**
   * One channel per bot. The singleton used to hold a SINGLE stream + botId,
   * so a multi-bot process (ARENA_API_KEYS fleet) clobbered itself: whichever
   * engine connected last owned the file and every other bot's events landed
   * in it or vanished — observed in the pass-3 prod run as exactly one
   * telemetry file per round for a three-bot fleet, which blocked the
   * friendly-fire investigation. Engines are single-threaded and each socket
   * handler runs synchronously, so a set-active-then-write context switch is
   * race-free.
   */
  private readonly channels = new Map<string, BotChannel>();
  private activeBot = "unknown";

  constructor() {
    this.enabled = process.env.TELEMETRY_LOG === "1";
    this.logDir = process.env.TELEMETRY_LOG_DIR ?? "logs/telemetry";
    if (this.enabled) {
      try {
        mkdirSync(this.logDir, { recursive: true });
      } catch {
        // if we can't create the dir, disable rather than throw from
        // the hot path later
        this.enabled = false;
      }
    }
  }

  /**
   * Route subsequent events to this bot's channel. Engines call it at the
   * top of every telemetry-producing socket handler (tick / round_start /
   * round_end); single-bot callers can rely on setBotId alone.
   */
  setActiveBot(botId: string) {
    this.activeBot = botId;
  }

  setBotId(botId: string) {
    this.activeBot = botId;
  }

  roundStart(roundId: string) {
    if (!this.enabled) return;
    this.openStream(this.activeBot, roundId);
    this.write({
      t: "round_start",
      ts: Date.now(),
      roundId,
      botId: this.activeBot,
    });
  }

  roundEnd(roundId: string, outcome: "win" | "loss" | "unknown") {
    if (!this.enabled) return;
    this.write({
      t: "round_end",
      ts: Date.now(),
      roundId,
      botId: this.activeBot,
      outcome,
    });
    this.closeStream(this.activeBot);
  }

  tickDecision(e: Omit<TickDecisionEvent, "t" | "ts">) {
    if (!this.enabled) return;
    this.write({ t: "tick_decision", ts: Date.now(), ...e });
  }

  targetSwitch(e: Omit<TargetSwitchEvent, "t" | "ts">) {
    if (!this.enabled) return;
    this.write({ t: "target_switch", ts: Date.now(), ...e });
  }

  tradeEvaluated(e: Omit<TradeEvaluatedEvent, "t" | "ts">) {
    if (!this.enabled) return;
    this.write({ t: "trade_evaluated", ts: Date.now(), ...e });
  }

  dodgeDecision(e: Omit<DodgeDecisionEvent, "t" | "ts">) {
    if (!this.enabled) return;
    this.write({ t: "dodge_decision", ts: Date.now(), ...e });
  }

  /** Call one tick later, once actual damage taken this tick is known. */
  dodgeResolved(e: Omit<DodgeResolvedEvent, "t" | "ts">) {
    if (!this.enabled) return;
    this.write({ t: "dodge_resolved", ts: Date.now(), ...e });
  }

  actionIssued(e: Omit<ActionIssuedEvent, "t" | "ts">) {
    if (!this.enabled) return;
    this.write({ t: "action_issued", ts: Date.now(), ...e });
  }

  // ---- internals ----

  private channel(botId: string): BotChannel {
    let c = this.channels.get(botId);
    if (!c) {
      c = { stream: null, ring: [], droppedCount: 0 };
      this.channels.set(botId, c);
    }
    return c;
  }

  private openStream(botId: string, roundId: string) {
    this.closeStream(botId);
    const c = this.channel(botId);
    const safeId = roundId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const path = join(this.logDir, `${botId}_${safeId}.jsonl`);
    c.stream = createWriteStream(path, { flags: "a" });
    c.ring = [];
    c.droppedCount = 0;
  }

  private closeStream(botId: string) {
    const c = this.channels.get(botId);
    if (c?.stream) {
      this.flushRing(c);
      c.stream.end();
      c.stream = null;
    }
  }

  private write(e: TelemetryEvent) {
    const c = this.channel(this.activeBot);
    const line = JSON.stringify(e);
    if (c.ring.length >= RING_BUFFER_MAX) {
      c.ring.shift();
      c.droppedCount++;
    }
    c.ring.push(line);
    // Drain opportunistically; createWriteStream handles backpressure
    // internally, we just avoid awaiting it in the caller.
    this.flushRing(c);
  }

  private flushRing(c: BotChannel) {
    if (!c.stream) return;
    while (c.ring.length > 0) {
      const line = c.ring.shift()!;
      const ok = c.stream.write(line + "\n");
      if (!ok) break; // let the stream drain; remaining lines stay buffered
    }
    if (c.droppedCount > 0) {
      // surfaced once per flush burst, not per event, to avoid log spam
      c.stream.write(
        JSON.stringify({
          t: "telemetry_dropped",
          ts: Date.now(),
          count: c.droppedCount,
        }) + "\n",
      );
      c.droppedCount = 0;
    }
  }
}

export const telemetry = new TelemetryLog();
