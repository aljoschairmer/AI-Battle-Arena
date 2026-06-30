/**
 * Token-bucket rate limiter. The arena caps outbound messages at 25/sec; we run
 * a slightly conservative budget so a burst (e.g. action + dodge in one tick)
 * never trips the server-side limiter and gets us kicked.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.lastRefill = now;
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
