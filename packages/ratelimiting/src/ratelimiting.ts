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
}
