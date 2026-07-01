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
    // Redact credentials before logging the URL (redis://user:pass@host:port).
    const safeUrl = url.replace(/\/\/[^@/]*@/, "//***@");
    const opts = {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      enableAutoPipelining: true,
      retryStrategy: (times: number) => Math.min(times * 200, 2000),
    };
    this.pub = new Redis(url, opts);
    this.sub = new Redis(url, opts);

    // Full connection-lifecycle logging on both connections, so it's obvious
    // from the logs whether Redis is actually reachable — not just "it threw
    // once" but connect/ready/reconnecting/close, matched to which connection
    // (pub: publish + KV, sub: pub/sub only) so a stuck subscriber vs. a dead
    // publisher are easy to tell apart.
    this.wireLifecycleLogging(this.pub, "pub", safeUrl);
    this.wireLifecycleLogging(this.sub, "sub", safeUrl);

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

  /** Logs every connection-state transition for one of the two Redis clients. */
  private wireLifecycleLogging(client: Redis, label: "pub" | "sub", url: string): void {
    client.on("connect", () => log.info({ conn: label, url }, "redis TCP connected"));
    client.on("ready", () => log.info({ conn: label }, "redis ready — commands flowing"));
    client.on("error", (e) => log.warn({ conn: label, err: e.message }, "redis connection error"));
    client.on("close", () => log.warn({ conn: label }, "redis connection closed"));
    client.on("reconnecting", (delay: number) => log.warn({ conn: label, delayMs: delay }, "redis reconnecting"));
    client.on("end", () => log.error({ conn: label }, "redis connection ended — giving up reconnecting"));
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
      log.debug({ channel }, "redis subscribed");
    }
    const typed = handler as (payload: unknown) => void;
    set.add(typed);

    return () => {
      const s = this.handlers.get(channel);
      if (!s) return;
      s.delete(typed);
      if (s.size === 0) {
        this.handlers.delete(channel);
        this.sub
          .unsubscribe(channel)
          .then(() => log.debug({ channel }, "redis unsubscribed"))
          .catch((e) => log.warn({ channel, err: (e as Error).message }, "redis unsubscribe failed"));
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
