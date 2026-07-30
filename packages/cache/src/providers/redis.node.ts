import { wrap } from "@primandproper/errors";
import {
  makeObserver,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";
import { Redis } from "ioredis";

import type { BatchCache, CacheSetOptions } from "../cache.js";
import {
  cacheInstruments,
  normalizeExpiryMs,
  resolveTtlMs,
  type CacheInstruments,
} from "../support.js";

const o11yName = "cache";

/**
 * ioredis client wiring shared by the platform's Node providers. Either constructs a client from
 * `url` (owned — {@link RedisCache.close} quits it) or reuses an injected `client` (unowned — the
 * caller owns its lifecycle). The constructed client deliberately fails fast instead of ioredis's
 * ~30s offline-queue hang against a down Redis: `maxRetriesPerRequest` is capped low so a command
 * rejects after a few reconnect attempts, and `commandTimeoutMs` (opt-in) bounds any single call.
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

export interface RedisCacheOptions extends RedisClientOptions {
  keyPrefix?: string;
  /**
   * Default TTL in milliseconds applied to entries written without their own. `0` or omitted
   * disables expiry. Individual writes override it via `set`'s {@link CacheSetOptions.ttlMs}.
   */
  expiryMs?: number;
}

/**
 * Node-only provider backed by Redis (ioredis). Values are JSON-encoded.
 *
 * Expiry is applied with `PX` (milliseconds) rather than `EX` (seconds) so a TTL survives the
 * round trip at the precision the interface advertises — `EX` would round 1500ms up to 2s.
 */
export class RedisCache<T> implements BatchCache<T> {
  readonly #client: Redis;
  readonly #ownsClient: boolean;
  readonly #prefix: string;
  readonly #expiryMs: number | undefined;
  readonly #observer: Observer;
  readonly #instruments: CacheInstruments;

  constructor(options: RedisCacheOptions, deps: ObservabilityDeps = {}) {
    ({ client: this.#client, owned: this.#ownsClient } = buildRedisClient(options));
    this.#prefix = options.keyPrefix ?? "";
    this.#expiryMs = normalizeExpiryMs(options.expiryMs);
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#instruments = cacheInstruments(o11yName, deps);
  }

  get(key: string): Promise<T | undefined> {
    return this.#observer.run("get", async (op) => {
      op.set("key", key);
      const fullKey = this.#key(key);
      const raw = await this.#client.get(fullKey);
      if (raw === null) {
        this.#instruments.misses.add(1);
        op.logger().debug("cache miss");
        return undefined;
      }
      try {
        const value = JSON.parse(raw) as T;
        this.#instruments.hits.add(1);
        return value;
      } catch (err) {
        // A poisoned entry must degrade to a miss, never throw on every read. Drop it so the next
        // set heals the key; a failing delete still degrades to a miss rather than re-throwing.
        op.logger().error("discarding corrupt cache entry", err);
        try {
          await this.#client.del(fullKey);
        } catch (delErr) {
          op.logger().error("failed to delete corrupt cache entry", delErr);
        }
        this.#instruments.misses.add(1);
        return undefined;
      }
    });
  }

  set(key: string, value: T, opts?: CacheSetOptions): Promise<void> {
    return this.#observer.run("set", async (op) => {
      op.set("key", key);
      let payload: string;
      try {
        payload = JSON.stringify(value);
      } catch (err) {
        throw wrap(`cache: failed to encode value for ${key}`, err);
      }
      const ttlMs = resolveTtlMs(opts, this.#expiryMs);
      try {
        if (ttlMs === undefined) {
          await this.#client.set(this.#key(key), payload);
        } else {
          await this.#client.set(this.#key(key), payload, "PX", ttlMs);
        }
      } catch (err) {
        throw wrap(`cache: failed to set ${key} on redis`, err);
      }
    });
  }

  delete(key: string): Promise<void> {
    return this.#observer.run("delete", async (op) => {
      op.set("key", key);
      await this.#client.del(this.#key(key));
    });
  }

  getMany(keys: string[]): Promise<Map<string, T>> {
    return this.#observer.run("getMany", async (op) => {
      op.set("keys", keys.length);
      const found = new Map<string, T>();
      if (keys.length === 0) {
        return found;
      }
      // One MGET round trip instead of N GETs.
      const raws = await this.#client.mget(keys.map((key) => this.#key(key)));
      const corrupt: string[] = [];
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const raw = raws[i];
        if (key === undefined || raw === null || raw === undefined) {
          this.#instruments.misses.add(1);
          continue;
        }
        try {
          found.set(key, JSON.parse(raw) as T);
          this.#instruments.hits.add(1);
        } catch (err) {
          // Same degrade-to-miss + heal policy as get(): drop the poisoned entry, count a miss.
          op.logger().error("discarding corrupt cache entry", err, { key });
          corrupt.push(this.#key(key));
          this.#instruments.misses.add(1);
        }
      }
      if (corrupt.length > 0) {
        try {
          await this.#client.del(corrupt);
        } catch (delErr) {
          op.logger().error("failed to delete corrupt cache entries", delErr);
        }
      }
      return found;
    });
  }

  setMany(items: Map<string, T>, opts?: CacheSetOptions): Promise<void> {
    return this.#observer.run("setMany", async (op) => {
      op.set("keys", items.size);
      if (items.size === 0) {
        return;
      }
      const ttlMs = resolveTtlMs(opts, this.#expiryMs);
      // Queue every write on one pipeline so the batch costs a single round trip.
      const pipeline = this.#client.pipeline();
      for (const [key, value] of items) {
        let payload: string;
        try {
          payload = JSON.stringify(value);
        } catch (err) {
          throw wrap(`cache: failed to encode value for ${key}`, err);
        }
        if (ttlMs === undefined) {
          pipeline.set(this.#key(key), payload);
        } else {
          pipeline.set(this.#key(key), payload, "PX", ttlMs);
        }
      }
      let results: [error: Error | null, result: unknown][] | null;
      try {
        results = await pipeline.exec();
      } catch (err) {
        throw wrap("cache: failed to set batch on redis", err);
      }
      // A pipeline resolves even when individual commands failed; surface the first such error.
      for (const [err] of results ?? []) {
        if (err !== null) {
          throw wrap("cache: failed to set batch on redis", err);
        }
      }
    });
  }

  async ping(): Promise<void> {
    await this.#client.ping();
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
