import { EventEmitter } from "node:events";
import type { Bus } from "./types";

/**
 * In-process bus for ROLE=all single-process runs (and tests). No network, no
 * serialization round-trip — handlers receive the published object directly.
 * We still deep-clone via structuredClone to mimic the isolation you'd get over
 * a real wire, so memory-mode behaviour matches Redis-mode behaviour.
 */
export class MemoryBus implements Bus {
  private readonly emitter = new EventEmitter();
  private readonly kv = new Map<string, unknown>();

  constructor() {
    // Many subscribers across both workers can attach to a single channel.
    this.emitter.setMaxListeners(100);
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
    this.kv.set(key, clone(value));
  }

  async getKV<T>(key: string): Promise<T | null> {
    const v = this.kv.get(key);
    return v === undefined ? null : (clone(v) as T);
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
