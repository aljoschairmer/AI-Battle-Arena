/**
 * src/shared/memoryStore.ts
 *
 * Disk persistence for the Brain's cross-round memory (RoundHistory,
 * OpponentRegistry, LearningInsights). The KV mirror expires after ~300s,
 * so before this existed a restarted brain forgot every opponent it had
 * ever fought — the opponent-profile counter-picking loop only worked
 * within a single process lifetime.
 *
 * Brain-side only, never on the engine hot path. All I/O is best-effort:
 * a read/write failure degrades to in-memory behavior (exactly what the
 * bot did before this file existed) and warns once. Writes are debounced
 * (at most one per WRITE_DEBOUNCE_MS) and atomic (tmp + rename) so a
 * crash mid-write can't corrupt the previous good snapshot.
 *
 * One file per bus scope (memory-bot0.json, ...) so parallel bots in one
 * process don't clobber each other. Disable with BRAIN_MEMORY=0; relocate
 * with BRAIN_MEMORY_DIR (default logs/brain).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LearningInsights, OpponentProfile, RoundOutcome } from "./memory";
import { child } from "./logger";

const log = child("brain:memory");

export interface BrainMemorySnapshot {
  /** Schema version for forward-compatible loads. */
  v: 1;
  savedAt: number;
  rounds: RoundOutcome[];
  profiles: OpponentProfile[];
  insights: LearningInsights | null;
}

const WRITE_DEBOUNCE_MS = 2000;

export class BrainMemoryStore {
  private enabled: boolean;
  private readonly path: string;
  private readonly tmpPath: string;
  private pending: BrainMemorySnapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private warned = false;

  constructor(scope = "") {
    this.enabled = process.env.BRAIN_MEMORY !== "0";
    const dir = process.env.BRAIN_MEMORY_DIR ?? "logs/brain";
    const safe = scope.replace(/[^a-zA-Z0-9_-]/g, "_");
    this.path = join(dir, safe ? `memory-${safe}.json` : "memory.json");
    this.tmpPath = `${this.path}.tmp`;
    if (this.enabled) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        this.enabled = false;
      }
    }
  }

  /** Synchronous, boot-time only. Null when absent/disabled/corrupt. */
  load(): BrainMemorySnapshot | null {
    if (!this.enabled) return null;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as BrainMemorySnapshot;
      if (raw?.v !== 1 || !Array.isArray(raw.rounds) || !Array.isArray(raw.profiles)) return null;
      return raw;
    } catch {
      return null; // first boot or unreadable — both fine
    }
  }

  /** Debounced, atomic, fire-and-forget. Latest snapshot wins. */
  save(snapshot: Omit<BrainMemorySnapshot, "v" | "savedAt">): void {
    if (!this.enabled) return;
    this.pending = { v: 1, savedAt: Date.now(), ...snapshot };
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const snap = this.pending;
      this.pending = null;
      if (!snap) return;
      try {
        writeFileSync(this.tmpPath, JSON.stringify(snap));
        renameSync(this.tmpPath, this.path);
      } catch (e) {
        if (!this.warned) {
          this.warned = true;
          log.warn({ err: (e as Error).message, path: this.path }, "brain memory persist failed — continuing in-memory");
        }
      }
    }, WRITE_DEBOUNCE_MS);
    // Don't hold the process open just to flush a snapshot.
    this.timer.unref?.();
  }

  /** Flush any pending snapshot immediately (shutdown path). */
  flush(): void {
    if (!this.enabled || !this.pending) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const snap = this.pending;
    this.pending = null;
    try {
      writeFileSync(this.tmpPath, JSON.stringify(snap));
      renameSync(this.tmpPath, this.path);
    } catch {
      /* shutdown best-effort */
    }
  }
}
