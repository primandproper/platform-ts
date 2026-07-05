import {
  makeObserver,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type { Cache } from "../cache.js";
import { cacheInstruments, type CacheInstruments } from "../support.js";

const o11yName = "cache";

interface StoredEntry<T> {
  value: T;
  expiresAt: number | null;
}

export interface WebStorageCacheOptions {
  namespace?: string;
  /** Per-entry TTL in milliseconds. `0` or omitted disables expiry. */
  expiryMs?: number;
  /** Storage backend; defaults to `localStorage`. Pass `sessionStorage` to opt in. */
  storage?: Storage;
}

/** Browser-only provider backed by Web Storage (localStorage by default). */
export class WebStorageCache<T> implements Cache<T> {
  readonly #storage: Storage;
  readonly #namespace: string;
  readonly #expiryMs: number | undefined;
  readonly #observer: Observer;
  readonly #instruments: CacheInstruments;

  constructor(options: WebStorageCacheOptions = {}, deps: ObservabilityDeps = {}) {
    this.#storage = options.storage ?? globalThis.localStorage;
    this.#namespace = options.namespace ?? "cache";
    this.#expiryMs =
      options.expiryMs !== undefined && options.expiryMs > 0
        ? options.expiryMs
        : undefined;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#instruments = cacheInstruments(o11yName, deps);
  }

  get(key: string): Promise<T | undefined> {
    return this.#observer.run("get", (op) => {
      op.set("key", key);
      const raw = this.#storage.getItem(this.#key(key));
      if (raw === null) {
        this.#instruments.misses.add(1);
        op.logger().debug("cache miss");
        return undefined;
      }
      let entry: StoredEntry<T>;
      try {
        entry = JSON.parse(raw) as StoredEntry<T>;
      } catch (err) {
        // A poisoned entry (another script's write, truncated storage) must degrade to a miss, not
        // throw on every read. Drop it so the next set heals the key.
        op.logger().error("discarding corrupt cache entry", err);
        this.#storage.removeItem(this.#key(key));
        this.#instruments.misses.add(1);
        return undefined;
      }
      if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
        this.#storage.removeItem(this.#key(key));
        this.#instruments.misses.add(1);
        op.logger().debug("cache miss");
        return undefined;
      }
      this.#instruments.hits.add(1);
      return entry.value;
    });
  }

  set(key: string, value: T): Promise<void> {
    return this.#observer.run("set", (op) => {
      op.set("key", key);
      const expiresAt = this.#expiryMs === undefined ? null : Date.now() + this.#expiryMs;
      const entry: StoredEntry<T> = { value, expiresAt };
      try {
        this.#storage.setItem(this.#key(key), JSON.stringify(entry));
      } catch (err) {
        // Web Storage is small (~5MB) and shared; a full quota is a routine, recoverable
        // condition for a cache — degrade to "not cached" with a warning rather than throwing.
        if (isQuotaExceeded(err)) {
          op.logger().warn("web storage quota exceeded; cache set skipped", { key });
          return;
        }
        throw err;
      }
    });
  }

  delete(key: string): Promise<void> {
    return this.#observer.run("delete", (op) => {
      op.set("key", key);
      this.#storage.removeItem(this.#key(key));
    });
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  #key(key: string): string {
    return `${this.#namespace}:${key}`;
  }
}

/**
 * True when a Web Storage write failed because the quota is full. Browsers signal this with a
 * `DOMException` named `QuotaExceededError` (or the legacy Firefox `NS_ERROR_DOM_QUOTA_REACHED`,
 * code 1014); match by name/code rather than `instanceof` so a fake storage in tests can trigger it.
 */
function isQuotaExceeded(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; code?: unknown };
  return (
    e.name === "QuotaExceededError" ||
    e.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    e.code === 22 ||
    e.code === 1014
  );
}
