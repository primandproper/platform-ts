/**
 * The outcome of a single rate-limit check. `allowed` is the decision; the remaining fields
 * let callers surface headers (`X-RateLimit-*`, `Retry-After`) without a second lookup.
 */
export interface RateLimitResult {
  /** Whether the request fits within the limit and may proceed. */
  allowed: boolean;
  /** Capacity left in the current window after accounting for this request. */
  remaining: number;
  /** The configured ceiling for the window. */
  limit: number;
  /** Epoch milliseconds at which the window resets and capacity is restored. */
  resetAt: number;
  /** When denied, how long the caller should wait before retrying, in milliseconds. */
  retryAfterMs?: number;
}

/**
 * The universal rate-limiter contract. A check both decides and consumes: calling
 * {@link limit} attributes `cost` units to `key` and returns whether the request is allowed.
 * Mirrors the Go platform's rate-limiting interface; providers under `providers/` back it
 * with memory, redis, or a noop.
 */
export interface RateLimiter {
  /**
   * Attributes `cost` (default `1`) units to `key` and reports whether the request is within
   * the limit. Denied requests still report `remaining` and `retryAfterMs` for headers.
   */
  limit(key: string, cost?: number): Promise<RateLimitResult>;
  /** Clears any accumulated usage for `key`, restoring full capacity. */
  reset(key: string): Promise<void>;
  /**
   * Releases any resources the limiter holds (e.g. a Redis connection) so the process can exit
   * gracefully. Providers that hold nothing resolve immediately; providers handed a shared client
   * leave it open for its owner. Idempotent — safe to call more than once.
   */
  close(): Promise<void>;
}

/**
 * Guards the `cost` argument shared by every provider. A negative cost would *mint* capacity
 * (memory subtracts it; redis `INCRBY`s a negative), so reject anything but a non-negative
 * integer up front.
 */
export function assertValidCost(cost: number): void {
  if (!Number.isInteger(cost) || cost < 0) {
    throw new TypeError(
      `rate limit cost must be a non-negative integer, got ${String(cost)}`,
    );
  }
}
