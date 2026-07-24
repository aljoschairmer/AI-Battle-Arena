/**
 * src/shared/knowledge.ts
 *
 * Repo-persisted knowledge dump & restore. Everything the bot LEARNS lives in
 * two places at runtime:
 *   1. the bus KV mirror (arena:kv:policy / arena:kv:insights per bot scope) —
 *      the Tuner's learned behaviour knobs and the Analyst's distilled
 *      insights, but with a ~300s TTL and gone entirely when Redis restarts,
 *   2. the brain memory files (BRAIN_MEMORY_DIR/memory*.json) — round
 *      history, opponent profiles, insights — durable, but outside the repo
 *      (logs/ is gitignored).
 *
 * `npm run knowledge:dump` snapshots both into KNOWLEDGE_DIR (default
 * data/knowledge/, committed to the repo). On process start,
 * restoreKnowledge() replays the dump the CONSERVATIVE way:
 *   - a KV key is seeded only when the bus doesn't currently hold one
 *     (a live Tuner's fresher policy is never clobbered), and the existing
 *     version/ts freshness checks + sanitizePolicy still apply downstream,
 *   - a memory file is copied only when the target doesn't exist yet
 *     (local learning always beats the committed seed).
 * So a fresh clone starts with everything the fleet ever learned, while a
 * long-running deployment is unaffected. Disable with KNOWLEDGE_RESTORE=0.
 */

import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Bus } from "../bus";
import { Keys } from "../bus";
import { child } from "./logger";

const log = child("knowledge");

/** The KV keys that hold LEARNED state (directives are round-scoped noise). */
const LEARNED_KEYS = [Keys.currentPolicy, Keys.learningInsights];

export interface KnowledgePaths {
  /** Dump location inside the repo (committed). */
  dir: string;
  /** Live brain memory dir (matches BrainMemoryStore's default). */
  brainDir: string;
}

export function knowledgePaths(): KnowledgePaths {
  return {
    dir: process.env.KNOWLEDGE_DIR ?? "data/knowledge",
    brainDir: process.env.BRAIN_MEMORY_DIR ?? "logs/brain",
  };
}

/** Full KV key for a bot scope ("" = unscoped/global). */
function scopedKey(scope: string, key: string): string {
  return scope ? `${scope}${key}` : key;
}

/**
 * Snapshot the learned KV entries (per scope) and every brain memory file
 * into the dump dir. Best-effort: an unreachable bus just yields fewer keys.
 * Returns a summary for logging/tests.
 */
export async function dumpKnowledge(
  /** null = no bus in this process (ROLE=scout) — file copies only, no KV. */
  bus: Bus | null,
  scopes: string[],
  paths: KnowledgePaths = knowledgePaths(),
): Promise<{ kvKeys: string[]; kvLive: string[]; memoryFiles: string[] }> {
  mkdirSync(join(paths.dir, "brain"), { recursive: true });

  // 1. Learned KV entries across every bot scope — MERGED over the existing
  // dump, never replacing it wholesale. The KV mirror carries a ~300s TTL
  // and is only rewritten when the Brain actually publishes; during an LLM
  // provider outage the entries expire and a naive dump would clobber the
  // committed seed with {} — measured live: an afternoon-long 402/429 storm
  // silently emptied kv.json and the learned Tuner policies survived only in
  // git history. A key is overwritten only when a live value exists; absent
  // keys keep their last known value (stale learning beats no learning; the
  // restore side is missing-only anyway, so a fresher live system ignores it).
  const kvPath = join(paths.dir, "kv.json");
  let kv: Record<string, unknown> = {};
  try {
    kv = JSON.parse(readFileSync(kvPath, "utf8")) as Record<string, unknown>;
  } catch {
    /* no previous dump / unreadable — start fresh */
  }
  const kvLive: string[] = [];
  if (bus) {
    for (const scope of scopes) {
      for (const key of LEARNED_KEYS) {
        const full = scopedKey(scope, key);
        try {
          const value = await bus.getKV<unknown>(full);
          if (value !== null) {
            kv[full] = value;
            kvLive.push(full);
          }
        } catch {
          /* bus unreachable — keep the previous dump's entries */
        }
      }
    }
  }
  writeFileSync(kvPath, JSON.stringify(kv, null, 2));

  // 2. Brain memory files (round history, opponent profiles, insights) plus
  // the Scout's watched-opponent profiles (scout.json — separate file so its
  // observed rounds never leak into our own weapon-evidence statistics).
  // Copied ONLY when the source is actually richer than what's already
  // committed (isSourceRicher) — a plain unconditional copy would let ANY
  // process with a smaller/older logs/brain/ (a fresh checkout, a container
  // that fell behind another session's longer-running scout/fleet) silently
  // regress shared knowledge the moment it dumps+pushes. Measured live: a
  // scout instance sitting at ~30 observed rounds would have overwritten a
  // sibling's already-committed 55-round snapshot on a naive copy.
  const memoryFiles: string[] = [];
  try {
    for (const f of readdirSync(paths.brainDir)) {
      if (!/^(memory.*|scout)\.json$/.test(f)) continue;
      const src = join(paths.brainDir, f);
      const dest = join(paths.dir, "brain", f);
      if (isSourceRicher(src, dest)) {
        copyFileSync(src, dest);
        memoryFiles.push(f);
      }
    }
  } catch {
    /* no brain dir yet — nothing learned on disk */
  }

  return { kvKeys: Object.keys(kv), kvLive, memoryFiles };
}

/**
 * Should `src` overwrite `dest`? True when `dest` is absent/corrupt, or when
 * `src` carries STRICTLY MORE observed history by the file's own "amount
 * learned" metric — `roundsObserved` for scout.json, `rounds.length` for
 * memory-*.json (BrainMemorySnapshot). `savedAt` (present on both shapes)
 * only breaks an exact tie: on its own it is NOT a safe primary signal — a
 * freshly (re)started process seeds a low-history file with a brand-new
 * timestamp, which would beat a long-accumulated file on recency alone even
 * though it holds far less information. Malformed source JSON never
 * overwrites a valid destination (fails closed).
 */
export function isSourceRicher(srcPath: string, destPath: string): boolean {
  let dest: { savedAt?: number; roundsObserved?: number; rounds?: unknown[] };
  try {
    dest = JSON.parse(readFileSync(destPath, "utf8")) as typeof dest;
  } catch {
    return true; // no valid destination to protect
  }
  let src: { savedAt?: number; roundsObserved?: number; rounds?: unknown[] };
  try {
    src = JSON.parse(readFileSync(srcPath, "utf8")) as typeof src;
  } catch {
    return false; // never let unreadable/corrupt source clobber a good file
  }
  const metric = (s: typeof src): number =>
    typeof s.roundsObserved === "number" ? s.roundsObserved : Array.isArray(s.rounds) ? s.rounds.length : -1;
  const srcAmount = metric(src);
  const destAmount = metric(dest);
  if (srcAmount !== destAmount) return srcAmount > destAmount;
  return (src.savedAt ?? 0) > (dest.savedAt ?? 0);
}

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { encoding: "utf8", timeout: 20_000, cwd });
  return stdout.trim();
}

/**
 * Auto-commit + push the knowledge dump when credentials allow it — so the
 * learning reaches the repo WITHOUT a human in the loop. Runs on the
 * startKnowledgeAutoPush schedule, NOT in the shutdown path: a dying process
 * only writes the dump to disk; the next scheduled run (or a human) pushes it.
 * Async on purpose — it shares a process with the 10 Hz engine, and a
 * synchronous git push would stall the tick loop for its full duration.
 *
 * Gating: runs when GITHUB_TOKEN or GH_TOKEN is set (or when forced with
 * KNOWLEDGE_AUTOPUSH=1, e.g. where the git remote already has ambient
 * credentials); KNOWLEDGE_AUTOPUSH=0 disables it entirely. Push tries the
 * remote's own credentials first and falls back to a token-authenticated
 * GitHub URL (x-access-token) for https remotes. Everything is best-effort:
 * a failure is logged and the dump simply stays local, exactly as before —
 * and the token is scrubbed from any error detail so it can never leak into
 * logs.
 */
export async function maybeCommitAndPushKnowledge(
  paths: KnowledgePaths = knowledgePaths(),
  cwd: string = process.cwd(),
): Promise<{ pushed: boolean; detail: string }> {
  const flag = (process.env.KNOWLEDGE_AUTOPUSH ?? "").toLowerCase();
  if (flag === "0" || flag === "false") return { pushed: false, detail: "KNOWLEDGE_AUTOPUSH=0" };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  const forced = flag === "1" || flag === "true";
  if (!token && !forced) return { pushed: false, detail: "no GITHUB_TOKEN/GH_TOKEN — auto-push off" };

  const scrub = (s: string): string => (token ? s.split(token).join("***") : s);
  try {
    if ((await git(["rev-parse", "--is-inside-work-tree"], cwd)) !== "true") {
      return { pushed: false, detail: "not inside a git work tree" };
    }
    if (!(await git(["status", "--porcelain", "--", paths.dir], cwd))) {
      return { pushed: false, detail: "no knowledge changes to commit" };
    }
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    if (branch === "HEAD") return { pushed: false, detail: "detached HEAD — not pushing" };

    await git(["add", "--", paths.dir], cwd);
    await git(
      [
        // Claude-session identity, not a bot identity: repo tooling (stop-hook
        // git check) flags any other committer email as Unverified and demands
        // a manual --reset-author amend on every automatic dump.
        "-c", "user.name=Claude",
        "-c", "user.email=noreply@anthropic.com",
        "commit", "-m", "data: automatic knowledge dump",
      ],
      cwd,
    );
    try {
      await git(["push", "origin", `HEAD:${branch}`], cwd);
    } catch (e) {
      // Remote refused with its own credentials — retry via the token for
      // GitHub https remotes (URL used ad hoc, never written to git config).
      const url = await git(["remote", "get-url", "origin"], cwd);
      const m = url.match(/^https:\/\/(?:[^@]+@)?github\.com\/(.+?)(?:\.git)?$/);
      if (!token || !m) throw e;
      await git(["push", `https://x-access-token:${token}@github.com/${m[1]}.git`, `HEAD:${branch}`], cwd);
    }
    log.info({ branch }, "knowledge dump auto-committed and pushed");
    return { pushed: true, detail: `pushed to ${branch}` };
  } catch (e) {
    const detail = scrub((e as Error).message).slice(0, 200);
    log.warn({ detail }, "knowledge auto-push failed — dump stays local");
    return { pushed: false, detail };
  }
}

/**
 * Background schedule for the knowledge commit+push: every intervalMs
 * (KNOWLEDGE_PUSH_INTERVAL_MS, default 15 min) snapshot the learned state and
 * let maybeCommitAndPushKnowledge's own gating decide whether it may commit
 * and push. This replaces the old push-on-SIGTERM behavior — the shutdown
 * path still writes the dump, but git runs only here, in a healthy process.
 * The timer is unref'd so it never keeps a stopping process alive; runs never
 * overlap (a slow push just skips the next slot).
 */
export function startKnowledgeAutoPush(
  bus: Bus | null,
  scopes: string[],
  opts: { intervalMs?: number; paths?: KnowledgePaths; cwd?: string } = {},
): { stop(): void } {
  const flag = (process.env.KNOWLEDGE_AUTOPUSH ?? "").toLowerCase();
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  const forced = flag === "1" || flag === "true";
  if (flag === "0" || flag === "false" || (!token && !forced)) {
    log.info("knowledge auto-push scheduler off (disabled or no GITHUB_TOKEN/GH_TOKEN)");
    return { stop() {} };
  }
  const envInterval = Number.parseInt(process.env.KNOWLEDGE_PUSH_INTERVAL_MS ?? "", 10);
  const intervalMs = Math.max(
    60_000, // floor: a typo'd env must not turn this into a busy git loop
    opts.intervalMs ?? (Number.isFinite(envInterval) ? envInterval : 15 * 60_000),
  );
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await dumpKnowledge(bus, scopes, opts.paths ?? knowledgePaths());
      await maybeCommitAndPushKnowledge(opts.paths, opts.cwd);
    } catch (e) {
      log.warn({ err: (e as Error).message }, "scheduled knowledge push failed — retrying next interval");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  log.info({ intervalMs }, "knowledge auto-push scheduled");
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

/**
 * Replay a committed dump into the live system — missing-only, never
 * overwriting. Called once at process start (before engines/brains spin up,
 * so the brain's KV seed read and BrainMemoryStore.load() find the data).
 */
export async function restoreKnowledge(
  bus: Bus,
  paths: KnowledgePaths = knowledgePaths(),
): Promise<{ kvSeeded: string[]; memorySeeded: string[] }> {
  const kvSeeded: string[] = [];
  const memorySeeded: string[] = [];
  const flag = (process.env.KNOWLEDGE_RESTORE ?? "true").toLowerCase();
  if (flag === "0" || flag === "false") return { kvSeeded, memorySeeded };

  // 1. KV entries — only where the bus holds nothing right now.
  const kvPath = join(paths.dir, "kv.json");
  if (existsSync(kvPath)) {
    let kv: Record<string, unknown> = {};
    try {
      kv = JSON.parse(readFileSync(kvPath, "utf8")) as Record<string, unknown>;
    } catch (e) {
      log.warn({ err: (e as Error).message, kvPath }, "knowledge kv.json unreadable — skipping KV restore");
    }
    for (const [key, value] of Object.entries(kv)) {
      try {
        if ((await bus.getKV<unknown>(key)) !== null) continue; // live state wins
        await bus.setKV(key, value);
        kvSeeded.push(key);
      } catch {
        /* bus unreachable — the KV mirror is an optimisation, not a dependency */
      }
    }
  }

  // 2. Brain memory files — only where none exists locally yet.
  const dumpBrain = join(paths.dir, "brain");
  if (existsSync(dumpBrain)) {
    try {
      mkdirSync(paths.brainDir, { recursive: true });
      for (const f of readdirSync(dumpBrain)) {
        if (!/^(memory.*|scout)\.json$/.test(f)) continue;
        const target = join(paths.brainDir, f);
        if (existsSync(target)) continue; // local learning wins
        copyFileSync(join(dumpBrain, f), target);
        memorySeeded.push(f);
      }
    } catch (e) {
      log.warn({ err: (e as Error).message }, "knowledge memory restore failed — continuing without seed");
    }
  }

  if (kvSeeded.length || memorySeeded.length) {
    log.info({ kvSeeded, memorySeeded }, "knowledge restored from repo dump");
  }
  return { kvSeeded, memorySeeded };
}
