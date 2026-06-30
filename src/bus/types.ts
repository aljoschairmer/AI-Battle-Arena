/**
 * Transport-agnostic message bus. Engine and Brain only ever depend on this
 * interface, so swapping Redis for the in-memory bus (or anything else) is a
 * one-line change in the factory.
 */
export interface Bus {
  /** Fire-and-forget publish of a JSON-serialisable payload to a channel. */
  publish<T>(channel: string, payload: T): Promise<void>;

  /** Subscribe to a channel. Returns an unsubscribe function. */
  subscribe<T>(channel: string, handler: (payload: T) => void): Promise<() => void>;

  /** Store a "last value" for late joiners / restarts. */
  setKV<T>(key: string, value: T): Promise<void>;

  /** Read the last stored value, or null if absent/unparseable. */
  getKV<T>(key: string): Promise<T | null>;

  /** Liveness check (used for /health and startup diagnostics). */
  ping(): Promise<boolean>;

  close(): Promise<void>;
}
