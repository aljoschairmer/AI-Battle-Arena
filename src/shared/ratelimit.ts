/**
 * Token-bucket rate limiter. The arena caps outbound messages at 25/sec; we run
 * a slightly conservative budget so a burst (e.g. action + dodge in one tick)
 * never trips the server-side limiter and gets us kicked.
 *
 * Time source is monotonic (performance.now) rather than Date.now: an NTP
 * step backwards under wall-clock time would freeze refills for the size of
 * the step — at 10 actions/sec the bucket drains in under a second, and every
 * outbound action is then dropped until the clock catches up, which is longer
 * than the arena's ~3s AFK timeout.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    /** Injectable monotonic clock (ms) — overridable for tests. */
    private readonly now: () => number = () => performance.now(),
  ) {
    this.tokens = capacity;
    this.lastRefill = this.now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = (t - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.lastRefill = t;
  }

  /** Try to spend one token. Returns true if allowed. */
  tryTake(cost = 1): boolean {
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  get available(): number {
    this.refill();
    return this.tokens;
  }
}
