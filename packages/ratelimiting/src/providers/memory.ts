import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type { RateLimiter, RateLimitResult } from "../ratelimiting.js";

const o11yName = "ratelimiting";

interface Window {
  /** Cost consumed in the current window. */
  used: number;
  /** Epoch ms at which the current window ends and capacity resets. */
  resetAt: number;
}

export interface MemoryRateLimiterOptions {
  /** Maximum cost permitted within a single window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/** Injectable clock + observability. `now` is overridable for deterministic tests. */
export interface MemoryRateLimiterDeps extends ObservabilityDeps {
  now?: () => number;
}

/**
 * Universal fixed-window rate limiter (a Map of per-key counters). Usable on both Node and
 * the browser, and the default provider in both environments. A window opens on the first
 * request for a key and lasts `windowMs`; once it elapses, capacity is fully restored.
 */
export class MemoryRateLimiter implements RateLimiter {
  readonly #windows = new Map<string, Window>();
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(options: MemoryRateLimiterOptions, deps: MemoryRateLimiterDeps = {}) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#now = deps.now ?? (() => Date.now());
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  limit(key: string, cost = 1): Promise<RateLimitResult> {
    const now = this.#now();
    let window = this.#windows.get(key);
    if (window === undefined || window.resetAt <= now) {
      window = { used: 0, resetAt: now + this.#windowMs };
      this.#windows.set(key, window);
    }

    if (window.used + cost > this.#limit) {
      this.#logger.debug("rate limit exceeded");
      return Promise.resolve({
        allowed: false,
        remaining: Math.max(0, this.#limit - window.used),
        limit: this.#limit,
        resetAt: window.resetAt,
        retryAfterMs: Math.max(0, window.resetAt - now),
      });
    }

    window.used += cost;
    return Promise.resolve({
      allowed: true,
      remaining: this.#limit - window.used,
      limit: this.#limit,
      resetAt: window.resetAt,
    });
  }

  reset(key: string): Promise<void> {
    this.#windows.delete(key);
    return Promise.resolve();
  }
}
