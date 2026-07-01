/**
 * scripts/analyze-telemetry.ts
 *
 * Reads one or more JSONL files produced by src/engine/telemetryLog.ts
 * and prints the metrics called for in Phase 2/3 of the audit:
 *
 *   - priority claim distribution (which priority wins the tick, how
 *     often, and what it falls through from)
 *   - target-switch frequency per fight (thrash detector)
 *   - trade-eval accuracy: did "engage" decisions with a predicted
 *     advantage actually correlate with not dying in that engagement?
 *   - dodge accuracy: fraction of dodges where predicted lowest-danger
 *     tile still resulted in damage taken
 *
 * Usage:
 *   npx tsx scripts/analyze-telemetry.ts logs/telemetry/*.jsonl
 *   npx tsx scripts/analyze-telemetry.ts logs/telemetry/bot0_round123.jsonl
 *
 * No dependencies beyond Node's fs/glob-free arg handling — pass
 * explicit paths (shell glob expansion) rather than adding a glob lib.
 */

import { readFileSync } from "node:fs";
import type {
  TelemetryEvent,
  TickDecisionEvent,
  TargetSwitchEvent,
  TradeEvaluatedEvent,
  DodgeDecisionEvent,
  DodgeResolvedEvent,
  ActionIssuedEvent,
  RoundBoundaryEvent,
} from "../src/engine/telemetryLog";

function loadEvents(path: string): TelemetryEvent[] {
  const raw = readFileSync(path, "utf8");
  const events: TelemetryEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.t === "telemetry_dropped") continue; // sink health, not analysis data
      events.push(parsed);
    } catch {
      // ignore partial/corrupt trailing line (e.g. stream cut mid-write)
    }
  }
  return events;
}

function analyzeFile(path: string) {
  const events = loadEvents(path);
  if (events.length === 0) {
    console.log(`\n=== ${path} === (empty or unparsable)`);
    return;
  }

  const roundStart = events.find((e): e is RoundBoundaryEvent => e.t === "round_start");
  const roundEnd = events.find((e): e is RoundBoundaryEvent => e.t === "round_end");
  const durationMs =
    roundStart && roundEnd ? roundEnd.ts - roundStart.ts : undefined;

  console.log(`\n=== ${path} ===`);
  console.log(
    `round: ${roundStart?.roundId ?? "?"}  outcome: ${roundEnd?.outcome ?? "?"}` +
      (durationMs ? `  duration: ${(durationMs / 1000).toFixed(1)}s` : ""),
  );

  // --- priority claim distribution ---
  const ticks = events.filter((e): e is TickDecisionEvent => e.t === "tick_decision");
  if (ticks.length > 0) {
    const counts = new Map<string, number>();
    for (const t of ticks) counts.set(t.priority, (counts.get(t.priority) ?? 0) + 1);
    console.log(`\npriority claims (${ticks.length} ticks):`);
    for (const [priority, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      const pct = ((count / ticks.length) * 100).toFixed(1);
      console.log(`  ${priority.padEnd(22)} ${String(count).padStart(5)}  (${pct}%)`);
    }
  }

  // --- target switch thrash ---
  const switches = events.filter((e): e is TargetSwitchEvent => e.t === "target_switch");
  if (switches.length > 0 && durationMs) {
    const perSecond = switches.length / (durationMs / 1000);
    const gaps = switches.map((s) => s.ticksSinceLastSwitch);
    const under5TickGaps = gaps.filter((g) => g < 5).length; // <500ms between switches
    console.log(`\ntarget switches: ${switches.length}  (${perSecond.toFixed(2)}/s)`);
    console.log(
      `  switches <500ms apart: ${under5TickGaps}/${switches.length}` +
        (under5TickGaps / switches.length > 0.3 ? "  ⚠ likely thrashing" : ""),
    );
  }

  // --- trade evaluation vs outcome ---
  // Heuristic: pair each "engage" trade eval with the dodge/damage
  // events that follow within the same target engagement window
  // (until the next trade_evaluated for a different target, or round end).
  const trades = events.filter((e): e is TradeEvaluatedEvent => e.t === "trade_evaluated");
  const dodgeResolved = events.filter(
    (e): e is DodgeResolvedEvent => e.t === "dodge_resolved",
  );
  if (trades.length > 0) {
    const engages = trades.filter((t) => t.decision === "engage");
    const badEngages = engages.filter((t) => t.predictedAdvantage < 0);
    console.log(`\ntrade evaluations: ${trades.length} total, ${engages.length} engage decisions`);
    if (badEngages.length > 0) {
      console.log(
        `  ⚠ engaged despite predicted disadvantage: ${badEngages.length}/${engages.length} ` +
          `(avg predicted advantage: ${(
            badEngages.reduce((s, t) => s + t.predictedAdvantage, 0) / badEngages.length
          ).toFixed(2)})`,
      );
    }
  }

  // --- action economy (pass-2 audit) ---
  // The server silently rejects a shove inside its 1.5s (15-tick) cooldown and
  // a use_gravity_well without a collected charge; both waste the whole tick.
  const issued = events.filter((e): e is ActionIssuedEvent => e.t === "action_issued");
  if (issued.length > 0) {
    const byAction = new Map<string, number>();
    for (const a of issued) byAction.set(a.action, (byAction.get(a.action) ?? 0) + 1);
    console.log(`\nactions issued (${issued.length}):`);
    for (const [action, count] of [...byAction.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${action.padEnd(18)} ${String(count).padStart(5)}`);
    }
    // Shove-cooldown violations: any shove issued <15 ticks after the previous one.
    const shoveTicks = issued.filter((a) => a.action === "shove").map((a) => a.tick);
    let shoveViolations = 0;
    for (let i = 1; i < shoveTicks.length; i++) {
      if (shoveTicks[i]! - shoveTicks[i - 1]! < 15) shoveViolations++;
    }
    if (shoveTicks.length > 0) {
      console.log(
        `  shove cooldown violations (<15 ticks apart): ${shoveViolations}/${shoveTicks.length}` +
          (shoveViolations > 0 ? "  ⚠ rejected server-side, wasted ticks" : ""),
      );
    }
    // Gravity-well spam: longest run of consecutive-tick use_gravity_well.
    const gwTicks = issued.filter((a) => a.action === "use_gravity_well").map((a) => a.tick);
    if (gwTicks.length > 0) {
      let maxRun = 1;
      let run = 1;
      for (let i = 1; i < gwTicks.length; i++) {
        run = gwTicks[i]! - gwTicks[i - 1]! <= 1 ? run + 1 : 1;
        if (run > maxRun) maxRun = run;
      }
      console.log(
        `  use_gravity_well issued: ${gwTicks.length}, longest consecutive-tick run: ${maxRun}` +
          (maxRun > 3 ? "  ⚠ stall loop — combat preempted by rejected casts" : ""),
      );
    }
  }

  // --- dodge accuracy ---
  const dodgeDecisions = events.filter(
    (e): e is DodgeDecisionEvent => e.t === "dodge_decision",
  );
  if (dodgeDecisions.length > 0) {
    const resolvedById = new Map(dodgeResolved.map((d) => [d.dodgeId, d]));
    let hitDespiteMinDanger = 0;
    let unresolved = 0;
    for (const d of dodgeDecisions) {
      const r = resolvedById.get(d.dodgeId);
      if (!r) {
        unresolved++;
        continue;
      }
      if (r.damageTaken > 0 && d.chosenTileDanger <= d.minAvailableDanger) {
        hitDespiteMinDanger++;
      }
    }
    console.log(
      `\ndodge decisions: ${dodgeDecisions.length}  (${unresolved} unresolved — check wiring)`,
    );
    console.log(
      `  hit despite choosing lowest-danger tile: ${hitDespiteMinDanger}/${dodgeDecisions.length - unresolved}` +
        (hitDespiteMinDanger > 0
          ? "  → threat field may be stale or miscalibrated, not just bad luck"
          : ""),
    );
  }
}

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("usage: npx tsx scripts/analyze-telemetry.ts <file.jsonl> [more files...]");
  process.exit(1);
}

for (const path of paths) {
  try {
    analyzeFile(path);
  } catch (err) {
    console.error(`failed to analyze ${path}:`, err);
  }
}
