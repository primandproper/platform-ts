import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type { Cache } from "../cache.js";

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
  readonly #logger: Logger;

  constructor(options: WebStorageCacheOptions = {}, deps: ObservabilityDeps = {}) {
    this.#storage = options.storage ?? globalThis.localStorage;
    this.#namespace = options.namespace ?? "cache";
    this.#expiryMs =
      options.expiryMs !== undefined && options.expiryMs > 0
        ? options.expiryMs
        : undefined;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  get(key: string): Promise<T | undefined> {
    const raw = this.#storage.getItem(this.#key(key));
    if (raw === null) {
      this.#logger.debug("cache miss");
      return Promise.resolve(undefined);
    }
    const entry = JSON.parse(raw) as StoredEntry<T>;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.#storage.removeItem(this.#key(key));
      return Promise.resolve(undefined);
    }
    return Promise.resolve(entry.value);
  }

  set(key: string, value: T): Promise<void> {
    const expiresAt = this.#expiryMs === undefined ? null : Date.now() + this.#expiryMs;
    const entry: StoredEntry<T> = { value, expiresAt };
    this.#storage.setItem(this.#key(key), JSON.stringify(entry));
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.#storage.removeItem(this.#key(key));
    return Promise.resolve();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  #key(key: string): string {
    return `${this.#namespace}:${key}`;
  }
}
