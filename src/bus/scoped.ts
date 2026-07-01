import type { Bus } from "./types";

/**
 * A Bus view that prefixes every channel and KV key with `prefix`, so multiple
 * independent bots can share one underlying bus (Redis or in-memory) without
 * their snapshots/directives/policies colliding. Each bot gets its own scope
 * (e.g. "bot0:"), so its engine and brain talk only to each other.
 *
 * close() is intentionally a no-op: the underlying bus is shared and owned by
 * the process, closed once at shutdown.
 */
export class ScopedBus implements Bus {
  constructor(
    private readonly inner: Bus,
    private readonly prefix: string,
  ) {}

  private k(name: string): string {
    return this.prefix ? `${this.prefix}${name}` : name;
  }

  publish<T>(channel: string, payload: T): Promise<void> {
    return this.inner.publish(this.k(channel), payload);
  }

  subscribe<T>(channel: string, handler: (payload: T) => void): Promise<() => void> {
    return this.inner.subscribe(this.k(channel), handler);
  }

  setKV<T>(key: string, value: T): Promise<void> {
    return this.inner.setKV(this.k(key), value);
  }

  getKV<T>(key: string): Promise<T | null> {
    return this.inner.getKV(this.k(key));
  }

  ping(): Promise<boolean> {
    return this.inner.ping();
  }

  async close(): Promise<void> {
    /* shared underlying bus — closed once by the owner */
  }
}

/** Wrap `bus` in a scope. An empty prefix returns the bus unchanged. */
export function scoped(bus: Bus, prefix: string): Bus {
  return prefix ? new ScopedBus(bus, prefix) : bus;
}
