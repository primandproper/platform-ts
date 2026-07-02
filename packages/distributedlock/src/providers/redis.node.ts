import { randomUUID } from "node:crypto";

import { wrap } from "@primandproper/errors";
import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";
import { Redis } from "ioredis";

import type { AcquireOptions, DistributedLock, Lock } from "../distributedlock.js";

const o11yName = "distributedlock";

export interface RedisDistributedLockOptions {
  url: string;
  keyPrefix?: string;
  /** Lease duration when {@link AcquireOptions.ttlMs} is omitted, in milliseconds. */
  defaultTtlMs?: number;
}

const DEFAULT_TTL_MS = 30_000;

/**
 * Frees the key only if it still holds this caller's token, so a holder that lost its lease
 * (expired, then re-acquired by another caller) cannot release the new holder's lock.
 *
 * KEYS[1] = lock key   ARGV[1] = token   reply = 1 if freed, 0 otherwise
 */
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

/**
 * Resets the lease expiry only if the key still holds this caller's token; a no-op otherwise.
 *
 * KEYS[1] = lock key   ARGV[1] = token   ARGV[2] = ttlMs   reply = 1 if extended, 0 otherwise
 */
const REFRESH_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`;

/**
 * Node-only provider backed by Redis (ioredis). Acquisition is an atomic `SET key token NX PX`,
 * so a key is granted iff it is free or has auto-expired against Redis's own clock. Each grant
 * stamps a unique token; release and refresh run compare-and-act Lua scripts against that token,
 * so a {@link Lock} only ever frees or extends a lease this caller still owns. Single-node Redis
 * mutual exclusion (not Redlock — one server, not a quorum); contention is `undefined`, not a throw.
 */
export class RedisDistributedLock implements DistributedLock {
  readonly #client: Redis;
  readonly #prefix: string;
  readonly #defaultTtlMs: number;
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(options: RedisDistributedLockOptions, deps: ObservabilityDeps = {}) {
    this.#client = new Redis(options.url, { lazyConnect: true });
    this.#prefix = options.keyPrefix ?? "";
    this.#defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  async acquire(key: string, opts: AcquireOptions = {}): Promise<Lock | undefined> {
    const ttlMs = opts.ttlMs ?? this.#defaultTtlMs;
    const token = randomUUID();
    const fullKey = this.#key(key);

    let reply: "OK" | null;
    try {
      reply = await this.#client.set(fullKey, token, "PX", ttlMs, "NX");
    } catch (err) {
      throw wrap(`distributedlock: failed to acquire ${key} on redis`, err);
    }

    if (reply === null) {
      this.#logger.debug("lock is already held");
      return undefined;
    }

    return this.#makeLock(key, fullKey, token, ttlMs);
  }

  async ping(): Promise<void> {
    try {
      await this.#client.ping();
    } catch (err) {
      throw wrap("distributedlock: redis ping failed", err);
    }
  }

  #key(key: string): string {
    return this.#prefix + key;
  }

  #makeLock(key: string, fullKey: string, token: string, ttlMs: number): Lock {
    const release = async (): Promise<void> => {
      let freed: number;
      try {
        freed = (await this.#client.eval(RELEASE_SCRIPT, 1, fullKey, token)) as number;
      } catch (err) {
        throw wrap(`distributedlock: failed to release ${key} on redis`, err);
      }
      if (freed === 0) {
        this.#logger.debug("release ignored: lease no longer owned");
      }
    };

    const refresh = async (newTtlMs?: number): Promise<void> => {
      let extended: number;
      try {
        extended = (await this.#client.eval(
          REFRESH_SCRIPT,
          1,
          fullKey,
          token,
          newTtlMs ?? ttlMs,
        )) as number;
      } catch (err) {
        throw wrap(`distributedlock: failed to refresh ${key} on redis`, err);
      }
      if (extended === 0) {
        this.#logger.debug("refresh ignored: lease no longer owned");
      }
    };

    return { key, release, refresh };
  }
}
