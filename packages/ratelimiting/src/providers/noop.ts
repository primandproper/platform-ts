import type { RateLimiter, RateLimitResult } from "../ratelimiting.js";

export interface NoopRateLimiterOptions {
  /** The ceiling reported back to callers; nothing is actually counted. */
  limit: number;
}

/** Universal limiter that counts nothing; every request is allowed. */
export class NoopRateLimiter implements RateLimiter {
  readonly #limit: number;

  constructor(options: NoopRateLimiterOptions) {
    this.#limit = options.limit;
  }

  limit(): Promise<RateLimitResult> {
    return Promise.resolve({
      allowed: true,
      remaining: this.#limit,
      limit: this.#limit,
      resetAt: 0,
    });
  }

  reset(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
