import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type { BatchCache } from "../cache.js";

const o11yName = "cache";

interface Entry<T> {
  value: T;
  expiresAt: number | undefined;
}

export interface MemoryCacheOptions {
  /** Per-entry TTL in milliseconds. `0` or omitted disables expiry. */
  expiryMs?: number;
}

/**
 * Universal in-memory cache (a Map with optional TTL). Usable on both Node and the browser,
 * and the default provider in both environments.
 */
export class InMemoryCache<T> implements BatchCache<T> {
  readonly #store = new Map<string, Entry<T>>();
  readonly #expiryMs: number | undefined;
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(options: MemoryCacheOptions = {}, deps: ObservabilityDeps = {}) {
    this.#expiryMs =
      options.expiryMs !== undefined && options.expiryMs > 0
        ? options.expiryMs
        : undefined;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  get(key: string): Promise<T | undefined> {
    const entry = this.#store.get(key);
    if (entry === undefined) {
      this.#logger.debug("cache miss");
      return Promise.resolve(undefined);
    }
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.#store.delete(key);
      this.#logger.debug("cache miss");
      return Promise.resolve(undefined);
    }
    return Promise.resolve(entry.value);
  }

  set(key: string, value: T): Promise<void> {
    const expiresAt =
      this.#expiryMs === undefined ? undefined : Date.now() + this.#expiryMs;
    this.#store.set(key, { value, expiresAt });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.#store.delete(key);
    return Promise.resolve();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  async getMany(keys: string[]): Promise<Map<string, T>> {
    const found = new Map<string, T>();
    for (const key of keys) {
      const value = await this.get(key);
      if (value !== undefined) {
        found.set(key, value);
      }
    }
    return found;
  }

  async setMany(items: Map<string, T>): Promise<void> {
    for (const [key, value] of items) {
      await this.set(key, value);
    }
  }
}
