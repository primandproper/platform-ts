import {
  makeObserver,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import {
  assertValidCost,
  type RateLimiter,
  type RateLimitResult,
} from "../ratelimiting.js";
import { rateLimiterInstruments, type RateLimiterInstruments } from "../support.js";

const o11yName = "ratelimiting";

/** Default cap on tracked keys before a sweep/eviction kicks in. */
const DEFAULT_MAX_KEYS = 100_000;

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
  /**
   * Upper bound on the number of tracked keys, to cap memory under high-cardinality keying
   * (per-IP/per-user). When a new key would exceed it, expired windows are swept first and, if
   * still over, the oldest-inserted entries are evicted. Defaults to {@link DEFAULT_MAX_KEYS}.
   */
  maxKeys?: number;
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
  readonly #maxKeys: number;
  readonly #now: () => number;
  readonly #observer: Observer;
  readonly #instruments: RateLimiterInstruments;

  constructor(options: MemoryRateLimiterOptions, deps: MemoryRateLimiterDeps = {}) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    this.#now = deps.now ?? (() => Date.now());
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#instruments = rateLimiterInstruments(o11yName, deps);
  }

  limit(key: string, cost = 1): Promise<RateLimitResult> {
    assertValidCost(cost);
    return this.#observer.run<RateLimitResult>("limit", (op) => {
      op.set("key", key);
      const now = this.#now();
      let window = this.#windows.get(key);
      if (window === undefined || window.resetAt <= now) {
        // Only a brand-new key grows the map; bound it before inserting so per-key state can't leak
        // unboundedly under high-cardinality keying.
        if (window === undefined && this.#windows.size >= this.#maxKeys) {
          this.#evict(now);
        }
        window = { used: 0, resetAt: now + this.#windowMs };
        this.#windows.set(key, window);
      }

      if (window.used + cost > this.#limit) {
        this.#instruments.denied.add(1);
        op.logger().debug("rate limit exceeded");
        return {
          allowed: false,
          remaining: Math.max(0, this.#limit - window.used),
          limit: this.#limit,
          resetAt: window.resetAt,
          retryAfterMs: Math.max(0, window.resetAt - now),
        };
      }

      window.used += cost;
      this.#instruments.allowed.add(1);
      return {
        allowed: true,
        remaining: this.#limit - window.used,
        limit: this.#limit,
        resetAt: window.resetAt,
      };
    });
  }

  reset(key: string): Promise<void> {
    this.#windows.delete(key);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Reclaims space when the key cap is hit: drop every expired window first (the common case —
   * these would have leaked), then, if still at the cap, evict oldest-inserted entries. Runs only
   * when a new key would exceed `maxKeys`, so its O(n) cost is amortized.
   */
  #evict(now: number): void {
    for (const [k, w] of this.#windows) {
      if (w.resetAt <= now) {
        this.#windows.delete(k);
      }
    }
    if (this.#windows.size >= this.#maxKeys) {
      const overflow = this.#windows.size - this.#maxKeys + 1;
      let removed = 0;
      for (const k of this.#windows.keys()) {
        if (removed >= overflow) {
          break;
        }
        this.#windows.delete(k);
        removed += 1;
      }
    }
  }
}
