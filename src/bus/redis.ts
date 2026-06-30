import Redis from "ioredis";
import { child } from "../shared/logger";
import type { Bus } from "./types";

const log = child("bus:redis");

/**
 * Redis-backed bus. Uses two connections because ioredis (like Redis itself)
 * puts a connection into subscriber mode where regular commands are illegal:
 *   - `pub`: PUBLISH + GET/SET (KV)
 *   - `sub`: SUBSCRIBE only
 *
 * Pub/sub gives push-latency directive delivery; the KV mirror lets a peer that
 * (re)starts mid-match immediately read the latest directive/loadout.
 */
export class RedisBus implements Bus {
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();

  constructor(url: string) {
    const opts = {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      enableAutoPipelining: true,
      retryStrategy: (times: number) => Math.min(times * 200, 2000),
    };
    this.pub = new Redis(url, opts);
    this.sub = new Redis(url, opts);

    this.pub.on("error", (e) => log.warn({ err: e.message }, "pub connection error"));
    this.sub.on("error", (e) => log.warn({ err: e.message }, "sub connection error"));

    this.sub.on("message", (channel: string, message: string) => {
      const set = this.handlers.get(channel);
      if (!set || set.size === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(message);
      } catch (e) {
        log.warn({ channel, err: (e as Error).message }, "dropping unparseable message");
        return;
      }
      for (const h of set) {
        try {
          h(parsed);
        } catch (e) {
          log.error({ channel, err: (e as Error).message }, "subscriber handler threw");
        }
      }
    });
  }

  async publish<T>(channel: string, payload: T): Promise<void> {
    await this.pub.publish(channel, JSON.stringify(payload));
  }

  async subscribe<T>(channel: string, handler: (payload: T) => void): Promise<() => void> {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
      await this.sub.subscribe(channel);
    }
    const typed = handler as (payload: unknown) => void;
    set.add(typed);

    return () => {
      const s = this.handlers.get(channel);
      if (!s) return;
      s.delete(typed);
      if (s.size === 0) {
        this.handlers.delete(channel);
        void this.sub.unsubscribe(channel).catch(() => undefined);
      }
    };
  }

  async setKV<T>(key: string, value: T): Promise<void> {
    // Expire after 5 minutes so stale state from a dead match doesn't linger.
    await this.pub.set(key, JSON.stringify(value), "EX", 300);
  }

  async getKV<T>(key: string): Promise<T | null> {
    const raw = await this.pub.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async ping(): Promise<boolean> {
    try {
      const r = await this.pub.ping();
      return r === "PONG";
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    try {
      this.pub.disconnect();
      this.sub.disconnect();
    } catch {
      /* ignore */
    }
  }
}
