/** Classic token bucket. `now` is injectable for tests. */
export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;
  private tokens: number;
  private last: number;

  constructor(capacity: number, refillPerSecond: number, now: () => number = Date.now) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.now = now;
    this.tokens = capacity;
    this.last = now();
  }

  take(cost = 1): boolean {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.refillPerSecond);
    this.last = t;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  /** True when the bucket has fully refilled, i.e. it carries no state worth keeping. */
  isIdle(): boolean {
    const t = this.now();
    return this.tokens + ((t - this.last) / 1000) * this.refillPerSecond >= this.capacity;
  }
}

/** Token buckets keyed by an arbitrary string (e.g. client IP), with idle eviction. */
export class KeyedLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;

  constructor(capacity: number, refillPerSecond: number, now: () => number = Date.now) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.now = now;
  }

  take(key: string, cost = 1): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.capacity, this.refillPerSecond, this.now);
      this.buckets.set(key, bucket);
    }
    return bucket.take(cost);
  }

  /** Drop buckets that have fully refilled. Call periodically. */
  sweep(): void {
    for (const [key, bucket] of this.buckets) if (bucket.isIdle()) this.buckets.delete(key);
  }

  get size(): number {
    return this.buckets.size;
  }
}
