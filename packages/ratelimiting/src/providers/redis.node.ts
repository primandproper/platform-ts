import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";
import { Redis } from "ioredis";

import type { RateLimiter, RateLimitResult } from "../ratelimiting.js";

export interface RedisRateLimiterOptions {
  url: string;
  keyPrefix?: string;
  /** Maximum cost permitted within a single window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/**
 * Atomic fixed-window check. INCRBY the counter; on the first hit of a window, set its TTL so
 * the window expires on its own. Returns the post-increment count and the remaining TTL (ms),
 * letting the caller compute the decision without a read-modify-write race.
 *
 * KEYS[1] = counter key   ARGV[1] = cost   ARGV[2] = windowMs
 * reply  = { count, pttl }
 */
const o11yName = "ratelimiting";

const FIXED_WINDOW_SCRIPT = `
local count = redis.call("INCRBY", KEYS[1], tonumber(ARGV[1]))
if count == tonumber(ARGV[1]) then
  redis.call("PEXPIRE", KEYS[1], tonumber(ARGV[2]))
end
local pttl = redis.call("PTTL", KEYS[1])
return { count, pttl }
`;

/** Node-only provider backed by Redis (ioredis). Fixed-window counters via an atomic Lua script. */
export class RedisRateLimiter implements RateLimiter {
  readonly #client: Redis;
  readonly #prefix: string;
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(options: RedisRateLimiterOptions, deps: ObservabilityDeps = {}) {
    this.#client = new Redis(options.url, { lazyConnect: true });
    this.#prefix = options.keyPrefix ?? "";
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  async limit(key: string, cost = 1): Promise<RateLimitResult> {
    const reply = (await this.#client.eval(
      FIXED_WINDOW_SCRIPT,
      1,
      this.#key(key),
      cost,
      this.#windowMs,
    )) as [number, number];
    const count = reply[0];
    const pttl = reply[1];
    // A missing or just-set key reports PTTL -1/-2; fall back to the full window.
    const resetAt = Date.now() + (pttl >= 0 ? pttl : this.#windowMs);

    if (count > this.#limit) {
      this.#logger.debug("rate limit exceeded");
      return {
        allowed: false,
        remaining: Math.max(0, this.#limit - (count - cost)),
        limit: this.#limit,
        resetAt,
        retryAfterMs: Math.max(0, resetAt - Date.now()),
      };
    }

    return {
      allowed: true,
      remaining: Math.max(0, this.#limit - count),
      limit: this.#limit,
      resetAt,
    };
  }

  async reset(key: string): Promise<void> {
    await this.#client.del(this.#key(key));
  }

  #key(key: string): string {
    return this.#prefix + key;
  }
}
