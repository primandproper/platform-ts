import { randomUUID } from "node:crypto";

import { wrap } from "@primandproper/errors";
import {
  makeObserver,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";
import { Redis } from "ioredis";

import type { AcquireOptions, DistributedLock, Lock } from "../distributedlock.js";

import { lockInstruments, type LockInstruments } from "./support.js";

const o11yName = "distributedlock";

/**
 * ioredis client wiring shared by the platform's Node providers. Either constructs a client from
 * `url` (owned — {@link RedisDistributedLock.close} quits it) or reuses an injected `client`
 * (unowned — the caller owns its lifecycle). The constructed client deliberately fails fast instead
 * of ioredis's ~30s offline-queue hang against a down Redis: `maxRetriesPerRequest` is capped low so
 * a command rejects after a few reconnect attempts, and `commandTimeoutMs` (opt-in) bounds any call.
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

export interface RedisDistributedLockOptions extends RedisClientOptions {
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

/** Custom-command names the release/refresh scripts are registered under (via ioredis `defineCommand`). */
const RELEASE_COMMAND = "dlRelease";
const REFRESH_COMMAND = "dlRefresh";

/** The client shape after the release/refresh commands are registered — EVALSHA under the hood. */
interface LockScriptClient {
  dlRelease(key: string, token: string): Promise<number>;
  dlRefresh(key: string, token: string, ttlMs: number): Promise<number>;
}

/**
 * Node-only provider backed by Redis (ioredis). Acquisition is an atomic `SET key token NX PX`,
 * so a key is granted iff it is free or has auto-expired against Redis's own clock. Each grant
 * stamps a unique token; release and refresh run compare-and-act Lua scripts against that token,
 * so a {@link Lock} only ever frees or extends a lease this caller still owns. Single-node Redis
 * mutual exclusion (not Redlock — one server, not a quorum); contention is `undefined`, not a throw.
 */
export class RedisDistributedLock implements DistributedLock {
  readonly #client: Redis;
  readonly #ownsClient: boolean;
  readonly #prefix: string;
  readonly #defaultTtlMs: number;
  readonly #observer: Observer;
  readonly #instruments: LockInstruments;

  constructor(options: RedisDistributedLockOptions, deps: ObservabilityDeps = {}) {
    ({ client: this.#client, owned: this.#ownsClient } = buildRedisClient(options));
    this.#prefix = options.keyPrefix ?? "";
    this.#defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#instruments = lockInstruments(o11yName, deps);
    // Register the compare-and-act scripts as custom commands so release/refresh go out as
    // EVALSHA (ioredis falls back to EVAL + re-caches on NOSCRIPT), not the full script each call.
    this.#client.defineCommand(RELEASE_COMMAND, { numberOfKeys: 1, lua: RELEASE_SCRIPT });
    this.#client.defineCommand(REFRESH_COMMAND, { numberOfKeys: 1, lua: REFRESH_SCRIPT });
  }

  acquire(key: string, opts: AcquireOptions = {}): Promise<Lock | undefined> {
    return this.#observer.run("acquire", async (op) => {
      op.set("key", key);
      const ttlMs = opts.ttlMs ?? this.#defaultTtlMs;
      const token = randomUUID();
      const fullKey = this.#key(key);

      let reply: "OK" | null;
      try {
        reply = await this.#client.set(fullKey, token, "PX", ttlMs, "NX");
      } catch (err) {
        throw op.error(
          wrap(`distributedlock: failed to acquire ${key} on redis`, err),
          "acquiring lock on redis",
        );
      }

      if (reply === null) {
        op.logger().debug("lock is already held");
        this.#instruments.contention.add(1, { operation: "acquire" });
        return undefined;
      }

      return this.#makeLock(key, fullKey, token, ttlMs);
    });
  }

  async ping(): Promise<void> {
    try {
      await this.#client.ping();
    } catch (err) {
      throw wrap("distributedlock: redis ping failed", err);
    }
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

  #makeLock(key: string, fullKey: string, token: string, ttlMs: number): Lock {
    const release = (): Promise<boolean> =>
      this.#observer.run("release", async (op) => {
        op.set("key", key);
        let freed: number;
        try {
          freed = await (this.#client as unknown as LockScriptClient).dlRelease(
            fullKey,
            token,
          );
        } catch (err) {
          throw op.error(
            wrap(`distributedlock: failed to release ${key} on redis`, err),
            "releasing lock on redis",
          );
        }
        if (freed === 0) {
          op.logger().debug("release ignored: lease no longer owned");
          this.#instruments.contention.add(1, { operation: "release" });
          return false;
        }
        return true;
      });

    const refresh = (newTtlMs?: number): Promise<boolean> =>
      this.#observer.run("refresh", async (op) => {
        op.set("key", key);
        let extended: number;
        try {
          extended = await (this.#client as unknown as LockScriptClient).dlRefresh(
            fullKey,
            token,
            newTtlMs ?? ttlMs,
          );
        } catch (err) {
          throw op.error(
            wrap(`distributedlock: failed to refresh ${key} on redis`, err),
            "refreshing lock on redis",
          );
        }
        if (extended === 0) {
          op.logger().debug("refresh ignored: lease no longer owned");
          this.#instruments.contention.add(1, { operation: "refresh" });
          return false;
        }
        return true;
      });

    return { key, release, refresh };
  }
}
