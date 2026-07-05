import {
  makeObserver,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type { BatchCache } from "../cache.js";
import { cacheInstruments, type CacheInstruments } from "../support.js";

const o11yName = "cache";

interface Entry<T> {
  value: T;
  expiresAt: number | undefined;
}

/** Default cap on live entries; a Map with no bound grows forever under per-key caching. */
const DEFAULT_MAX_ENTRIES = 100_000;

export interface MemoryCacheOptions {
  /** Per-entry TTL in milliseconds. `0` or omitted disables expiry. */
  expiryMs?: number;
  /**
   * Maximum number of live entries. When a new key would exceed it, expired entries are swept
   * first, then oldest-inserted entries are evicted until there is room. `0` disables the cap
   * (unbounded — only opt in when you know the keyspace is small). Defaults to 100,000.
   */
  maxEntries?: number;
}

/**
 * Universal in-memory cache (a Map with optional TTL). Usable on both Node and the browser,
 * and the default provider in both environments.
 *
 * Values are cloned (via `structuredClone`) on the way in and out, so a caller mutating an object
 * it stored — or one it read back — cannot corrupt the cached copy. This mirrors the isolation the
 * Redis provider gets for free from serialization. NOTE: `structuredClone` preserves `Date`/`Map`/
 * `Set` that the Redis provider's JSON round-trip would mangle, so a value's *type fidelity* still
 * differs between the two providers — don't rely on either beyond JSON-safe shapes for portability.
 */
export class InMemoryCache<T> implements BatchCache<T> {
  readonly #store = new Map<string, Entry<T>>();
  readonly #expiryMs: number | undefined;
  readonly #maxEntries: number | undefined;
  readonly #observer: Observer;
  readonly #instruments: CacheInstruments;

  constructor(options: MemoryCacheOptions = {}, deps: ObservabilityDeps = {}) {
    this.#expiryMs =
      options.expiryMs !== undefined && options.expiryMs > 0
        ? options.expiryMs
        : undefined;
    this.#maxEntries =
      options.maxEntries === undefined
        ? DEFAULT_MAX_ENTRIES
        : options.maxEntries > 0
          ? options.maxEntries
          : undefined;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#instruments = cacheInstruments(o11yName, deps);
  }

  get(key: string): Promise<T | undefined> {
    return this.#observer.run("get", (op) => {
      op.set("key", key);
      const entry = this.#store.get(key);
      if (entry === undefined) {
        this.#instruments.misses.add(1);
        op.logger().debug("cache miss");
        return undefined;
      }
      if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
        this.#store.delete(key);
        this.#instruments.misses.add(1);
        op.logger().debug("cache miss");
        return undefined;
      }
      this.#instruments.hits.add(1);
      // Return a clone so the caller can't mutate the cached copy through the reference.
      return structuredClone(entry.value);
    });
  }

  set(key: string, value: T): Promise<void> {
    return this.#observer.run("set", (op) => {
      op.set("key", key);
      const expiresAt =
        this.#expiryMs === undefined ? undefined : Date.now() + this.#expiryMs;
      if (!this.#store.has(key)) {
        this.#evictIfNeeded();
      }
      // Store a clone so a later mutation of the caller's object can't corrupt the cached copy.
      this.#store.set(key, { value: structuredClone(value), expiresAt });
    });
  }

  /**
   * Makes room for one new entry when at the cap: sweeps expired entries first (the ones that
   * leak under read-time-only eviction), then evicts oldest-inserted entries until under the cap.
   * Amortized O(n) and only runs at the boundary. No-op when the cap is disabled.
   */
  #evictIfNeeded(): void {
    if (this.#maxEntries === undefined || this.#store.size < this.#maxEntries) {
      return;
    }
    const now = Date.now();
    for (const [key, entry] of this.#store) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
        this.#store.delete(key);
      }
    }
    while (this.#store.size >= this.#maxEntries) {
      const oldest = this.#store.keys().next().value;
      if (oldest === undefined) break;
      this.#store.delete(oldest);
    }
  }

  delete(key: string): Promise<void> {
    return this.#observer.run("delete", (op) => {
      op.set("key", key);
      this.#store.delete(key);
    });
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
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
