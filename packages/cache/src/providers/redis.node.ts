import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";
import { Redis } from "ioredis";

import type { Cache } from "../cache.js";

const o11yName = "cache";

export interface RedisCacheOptions {
  url: string;
  keyPrefix?: string;
  /** Per-entry TTL in milliseconds. `0` or omitted disables expiry. */
  expiryMs?: number;
}

/** Node-only provider backed by Redis (ioredis). Values are JSON-encoded. */
export class RedisCache<T> implements Cache<T> {
  readonly #client: Redis;
  readonly #prefix: string;
  readonly #ttlSeconds: number | undefined;
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(options: RedisCacheOptions, deps: ObservabilityDeps = {}) {
    this.#client = new Redis(options.url, { lazyConnect: true });
    this.#prefix = options.keyPrefix ?? "";
    this.#ttlSeconds =
      options.expiryMs !== undefined && options.expiryMs > 0
        ? Math.ceil(options.expiryMs / 1000)
        : undefined;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  async get(key: string): Promise<T | undefined> {
    const raw = await this.#client.get(this.#key(key));
    if (raw === null) {
      this.#logger.debug("cache miss");
      return undefined;
    }
    const parsed: unknown = JSON.parse(raw);
    return parsed as T;
  }

  async set(key: string, value: T): Promise<void> {
    const payload = JSON.stringify(value);
    if (this.#ttlSeconds === undefined) {
      await this.#client.set(this.#key(key), payload);
    } else {
      await this.#client.set(this.#key(key), payload, "EX", this.#ttlSeconds);
    }
  }

  async delete(key: string): Promise<void> {
    await this.#client.del(this.#key(key));
  }

  async ping(): Promise<void> {
    await this.#client.ping();
  }

  #key(key: string): string {
    return this.#prefix + key;
  }
}
