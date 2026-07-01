import { EventEmitter } from "node:events";
import type { Bus } from "./types";

/**
 * In-process bus for ROLE=all single-process runs (and tests). No network, no
 * serialization round-trip — handlers receive the published object directly.
 * We still deep-clone via structuredClone to mimic the isolation you'd get over
 * a real wire, so memory-mode behaviour matches Redis-mode behaviour.
 */
/** Matches RedisBus.setKV's `EX 300` so both buses expire KV identically. */
export const KV_TTL_MS = 300_000;

export class MemoryBus implements Bus {
  private readonly emitter = new EventEmitter();
  private readonly kv = new Map<string, { v: unknown; expiresAt: number }>();
  private readonly kvTtlMs: number;

  constructor(opts: { kvTtlMs?: number } = {}) {
    // Many subscribers across both workers can attach to a single channel.
    this.emitter.setMaxListeners(100);
    this.kvTtlMs = opts.kvTtlMs ?? KV_TTL_MS;
  }

  async publish<T>(channel: string, payload: T): Promise<void> {
    const cloned = clone(payload);
    // Defer to a microtask so publish() never reenters a handler synchronously
    // (keeps semantics close to async network delivery).
    queueMicrotask(() => this.emitter.emit(channel, cloned));
  }

  async subscribe<T>(channel: string, handler: (payload: T) => void): Promise<() => void> {
    const wrapped = (payload: T) => handler(payload);
    this.emitter.on(channel, wrapped as (p: unknown) => void);
    return () => this.emitter.off(channel, wrapped as (p: unknown) => void);
  }

  async setKV<T>(key: string, value: T): Promise<void> {
    // Expire like RedisBus (EX 300) so stale state from a dead match doesn't
    // linger here either — BUS=memory must validate BUS=redis behaviour.
    this.kv.set(key, { v: clone(value), expiresAt: Date.now() + this.kvTtlMs });
  }

  async getKV<T>(key: string): Promise<T | null> {
    const entry = this.kv.get(key);
    if (entry === undefined) return null;
    if (Date.now() >= entry.expiresAt) {
      this.kv.delete(key);
      return null;
    }
    return clone(entry.v) as T;
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.emitter.removeAllListeners();
    this.kv.clear();
  }
}

function clone<T>(v: T): T {
  try {
    return structuredClone(v);
  } catch {
    // Fall back to JSON for anything structuredClone can't handle.
    return JSON.parse(JSON.stringify(v)) as T;
  }
}
