import { wrap } from "@primandproper/errors";
import {
  makeObserver,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";
import { Redis } from "ioredis";

import {
  assertValidCost,
  type RateLimiter,
  type RateLimitResult,
} from "../ratelimiting.js";
import { rateLimiterInstruments, type RateLimiterInstruments } from "../support.js";

/**
 * ioredis client wiring shared by the platform's Node providers. Either constructs a client from
 * `url` (owned — {@link RedisRateLimiter.close} quits it) or reuses an injected `client` (unowned —
 * the caller owns its lifecycle). The constructed client deliberately fails fast instead of
 * ioredis's ~30s offline-queue hang against a down Redis: `maxRetriesPerRequest` is capped low so a
 * command rejects after a few reconnect attempts, and `commandTimeoutMs` (opt-in) bounds any call.
 */
export interface RedisClientOptions {
  url: string;
  /** Reuse an existing ioredis client instead of constructing one; the caller owns its lifecycle. */
  client?: Redis;
  /** TCP connect timeout in ms (ioredis `connectTimeout`). Defaults to ioredis's 10s. */
  connectTimeoutMs?: number;
  /** Reject a command that outlives this many ms. Off by default; the fail-fast timeout knob. */
  commandTimeoutMs?: number;
  /** Reconnect attempts a queued command survives before rejecting. Defaults to 3 (ioredis: 20). */
  maxRetriesPerRequest?: number;
  /** Whether commands issued while disconnected queue (true) or reject at once. Defaults to true. */
  enableOfflineQueue?: boolean;
}

export function buildRedisClient(options: RedisClientOptions): {
  client: Redis;
  owned: boolean;
} {
  if (options.client !== undefined) {
    return { client: options.client, owned: false };
  }
  const client = new Redis(options.url, {
    lazyConnect: true,
    connectTimeout: options.connectTimeoutMs ?? 10_000,
    maxRetriesPerRequest: options.maxRetriesPerRequest ?? 3,
    enableOfflineQueue: options.enableOfflineQueue ?? true,
    ...(options.commandTimeoutMs !== undefined
      ? { commandTimeout: options.commandTimeoutMs }
      : {}),
  });
  return { client, owned: true };
}

export interface RedisRateLimiterOptions extends RedisClientOptions {
  keyPrefix?: string;
  /** Maximum cost permitted within a single window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /**
   * What to do when Redis is unreachable or errors. `false` (the default) **fails closed** — a
   * limiter that can't verify remaining capacity denies the request, so a Redis outage can't turn
   * into an open floodgate. Set `true` to **fail open** — trade the limit's guarantee for
   * availability, admitting requests while Redis is down. Either way the underlying error is wrapped
   * with context and logged.
   */
  failOpen?: boolean;
}

/**
 * Atomic fixed-window check. INCRBY the counter, then read its TTL. If the key has no expiry set
 * (`PTTL` returns -1 for a key with no TTL, -2 for a missing one — both `< 0`), (re)arm it. This
 * covers the first hit of a window *and* self-heals a counter that somehow lost its expiry (a manual
 * PERSIST, a crash between INCRBY and PEXPIRE under an older script, a restore without TTLs): without
 * the re-arm such a counter would never reset and would wedge the key at "denied" forever. Returns
 * the post-increment count and the (now guaranteed positive) remaining TTL in ms, letting the caller
 * compute the decision without a read-modify-write race.
 *
 * KEYS[1] = counter key   ARGV[1] = cost   ARGV[2] = windowMs
 * reply  = { count, pttl }
 */
const o11yName = "ratelimiting";

const FIXED_WINDOW_SCRIPT = `
local count = redis.call("INCRBY", KEYS[1], tonumber(ARGV[1]))
local pttl = redis.call("PTTL", KEYS[1])
if pttl < 0 then
  redis.call("PEXPIRE", KEYS[1], tonumber(ARGV[2]))
  pttl = tonumber(ARGV[2])
end
return { count, pttl }
`;

/** The custom-command name the fixed-window script is registered under (via ioredis `defineCommand`). */
const FIXED_WINDOW_COMMAND = "rlFixedWindow";

/** The client shape after {@link FIXED_WINDOW_COMMAND} is registered — EVALSHA under the hood. */
interface FixedWindowClient {
  rlFixedWindow(key: string, cost: number, windowMs: number): Promise<[number, number]>;
}

/** Node-only provider backed by Redis (ioredis). Fixed-window counters via an atomic Lua script. */
export class RedisRateLimiter implements RateLimiter {
  readonly #client: Redis;
  readonly #ownsClient: boolean;
  readonly #prefix: string;
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #failOpen: boolean;
  readonly #observer: Observer;
  readonly #instruments: RateLimiterInstruments;

  constructor(options: RedisRateLimiterOptions, deps: ObservabilityDeps = {}) {
    ({ client: this.#client, owned: this.#ownsClient } = buildRedisClient(options));
    this.#prefix = options.keyPrefix ?? "";
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#failOpen = options.failOpen ?? false;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#instruments = rateLimiterInstruments(o11yName, deps);
    // Register the script as a custom command so calls go out as EVALSHA (ioredis falls back to
    // EVAL + re-caches on NOSCRIPT), instead of shipping the whole script body every limit().
    this.#client.defineCommand(FIXED_WINDOW_COMMAND, {
      numberOfKeys: 1,
      lua: FIXED_WINDOW_SCRIPT,
    });
  }

  async limit(key: string, cost = 1): Promise<RateLimitResult> {
    assertValidCost(cost);
    return this.#observer.run<RateLimitResult>("limit", async (op) => {
      op.set("key", key);
      let reply: [number, number];
      try {
        reply = await (this.#client as unknown as FixedWindowClient).rlFixedWindow(
          this.#key(key),
          cost,
          this.#windowMs,
        );
      } catch (err) {
        // ioredis surfaces bare connection/timeout errors; wrap with context before deciding.
        const wrapped = wrap(`ratelimiting: redis limit failed for ${key}`, err);
        op.logger().error("rate limiter redis error", wrapped, {
          failOpen: this.#failOpen,
        });
        return this.#onRedisError();
      }
      const count = reply[0];
      const pttl = reply[1];
      // A missing or just-set key reports PTTL -1/-2; fall back to the full window.
      const resetAt = Date.now() + (pttl >= 0 ? pttl : this.#windowMs);

      if (count > this.#limit) {
        this.#instruments.denied.add(1);
        op.logger().debug("rate limit exceeded");
        return {
          allowed: false,
          remaining: Math.max(0, this.#limit - (count - cost)),
          limit: this.#limit,
          resetAt,
          retryAfterMs: Math.max(0, resetAt - Date.now()),
        };
      }

      this.#instruments.allowed.add(1);
      return {
        allowed: true,
        remaining: Math.max(0, this.#limit - count),
        limit: this.#limit,
        resetAt,
      };
    });
  }

  /**
   * The explicit fail policy when a Redis command errors. Fail-closed (default) denies with a full
   * `retryAfterMs` so callers back off; fail-open admits at full remaining capacity. Both paths tally
   * the corresponding instrument so a Redis outage is visible in the allowed/denied metrics.
   */
  #onRedisError(): RateLimitResult {
    const resetAt = Date.now() + this.#windowMs;
    if (this.#failOpen) {
      this.#instruments.allowed.add(1);
      return { allowed: true, remaining: this.#limit, limit: this.#limit, resetAt };
    }
    this.#instruments.denied.add(1);
    return {
      allowed: false,
      remaining: 0,
      limit: this.#limit,
      resetAt,
      retryAfterMs: this.#windowMs,
    };
  }

  async reset(key: string): Promise<void> {
    await this.#client.del(this.#key(key));
  }

  /**
   * Closes the connection, draining in-flight commands (`quit`) and falling back to an immediate
   * `disconnect` if the graceful quit fails. A no-op for an injected client — the caller owns it.
   */
  async close(): Promise<void> {
    if (!this.#ownsClient) {
      return;
    }
    try {
      await this.#client.quit();
    } catch {
      this.#client.disconnect();
    }
  }

  #key(key: string): string {
    return this.#prefix + key;
  }
}
