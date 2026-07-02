/* eslint-disable no-console */
/**
 * scripts/analyze-outcomes.ts
 *
 * Reads the persistent round-outcome log (src/engine/outcomeLog.ts) and
 * answers the baseline questions for the win-rate pass:
 *
 *   - win rate over the last N rounds (per variant, per weapon)
 *   - loss-cause distribution: who/what killed us, with what weapon
 *   - death context: solo kill vs multiple attackers that round (gank proxy),
 *     ticks survived, modifier splits
 *
 * Usage:
 *   npx tsx scripts/analyze-outcomes.ts [path=logs/outcomes/outcomes.jsonl] [--last N]
 */
import { readFileSync } from "node:fs";
import type { OutcomeEntry } from "../src/engine/outcomeLog";

const args = process.argv.slice(2);
const lastIdx = args.indexOf("--last");
const lastN = lastIdx >= 0 ? Number(args[lastIdx + 1]) : Infinity;
const path = args.find((a) => !a.startsWith("--") && a !== String(lastN)) ?? "logs/outcomes/outcomes.jsonl";

let entries: OutcomeEntry[] = [];
try {
  entries = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as OutcomeEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is OutcomeEntry => e !== null && e.t === "round_outcome");
} catch (e) {
  console.error(`cannot read ${path}: ${(e as Error).message}`);
  process.exit(1);
}

if (Number.isFinite(lastN)) entries = entries.slice(-lastN);
if (entries.length === 0) {
  console.log(`no outcomes in ${path}`);
  process.exit(0);
}

const pct = (n: number, d: number) => (d === 0 ? "-" : `${((n / d) * 100).toFixed(1)}%`);

function summarize(label: string, rows: OutcomeEntry[]): void {
  const wins = rows.filter((r) => r.won).length;
  const losses = rows.filter((r) => !r.won);
  console.log(`\n=== ${label}: ${rows.length} rounds, ${wins} wins (${pct(wins, rows.length)}) ===`);

  const kd = rows.reduce<[number, number]>((a, r) => [a[0] + r.kills, a[1] + r.deaths], [0, 0]);
  const avgTicks = rows.reduce((a, r) => a + r.ticksSurvived, 0) / rows.length;
  console.log(`kills ${kd[0]} / deaths ${kd[1]}  ·  avg ticks survived ${avgTicks.toFixed(0)}`);

  // Loss causes
  const byCause = new Map<string, number>();
  for (const r of losses) byCause.set(r.causeOfDeath, (byCause.get(r.causeOfDeath) ?? 0) + 1);
  console.log(`loss causes (${losses.length} losses):`);
  for (const [c, n] of [...byCause].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.padEnd(20)} ${n}  (${pct(n, losses.length)})`);
  }

  // Final killer weapon distribution across losses with a bot kill
  const killerWeapons = new Map<string, number>();
  const killers = new Map<string, number>();
  let gankLosses = 0;
  for (const r of losses) {
    const last = r.killedBy[r.killedBy.length - 1];
    if (!last) continue;
    killerWeapons.set(last.weapon, (killerWeapons.get(last.weapon) ?? 0) + 1);
    killers.set(last.name, (killers.get(last.name) ?? 0) + 1);
    // gank proxy: more than one distinct bot damaged-killed us this round
    if (new Set(r.killedBy.map((k) => k.botId)).size > 1) gankLosses++;
  }
  if (killerWeapons.size > 0) {
    console.log(
      `final-killer weapons: ${[...killerWeapons].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w}:${n}`).join("  ")}`,
    );
    console.log(
      `top killers: ${[...killers].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w, n]) => `${w}:${n}`).join("  ")}`,
    );
    console.log(`multi-attacker (gank-proxy) losses: ${gankLosses} (${pct(gankLosses, losses.length)})`);
  }

  // Weapon + modifier splits
  const byWeapon = new Map<string, { w: number; n: number }>();
  const byMod = new Map<string, { w: number; n: number }>();
  for (const r of rows) {
    const w = byWeapon.get(r.ourWeapon ?? "?") ?? { w: 0, n: 0 };
    w.n++;
    if (r.won) w.w++;
    byWeapon.set(r.ourWeapon ?? "?", w);
    const m = byMod.get(r.roundModifier || "none") ?? { w: 0, n: 0 };
    m.n++;
    if (r.won) m.w++;
    byMod.set(r.roundModifier || "none", m);
  }
  console.log(`by weapon: ${[...byWeapon].map(([k, v]) => `${k} ${v.w}/${v.n}`).join("  ")}`);
  console.log(`by modifier: ${[...byMod].map(([k, v]) => `${k} ${v.w}/${v.n}`).join("  ")}`);

  const withElo = rows.filter((r) => typeof r.elo === "number");
  if (withElo.length >= 2) {
    console.log(`elo: ${withElo[0]!.elo} → ${withElo[withElo.length - 1]!.elo}`);
  }
}

summarize("ALL", entries);
const variants = new Set(entries.map((e) => e.variant || "(untagged)"));
if (variants.size > 1) {
  for (const v of variants) summarize(`variant ${v}`, entries.filter((e) => (e.variant || "(untagged)") === v));
}
