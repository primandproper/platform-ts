import { type Cache, provideCache } from "@primandproper/cache";
import type { ObservabilityDeps } from "@primandproper/observability";

import { getRequired, type SecretSource } from "../secrets.js";

/** Thirty seconds — the default memoization TTL, short enough that a rotated secret is picked up soon. */
export const DEFAULT_SECRET_TTL_MS = 30_000;

export interface CachingSecretSourceOptions {
  /** Memoization TTL in milliseconds. `0` disables it entirely. Defaults to 30s. */
  ttlMs?: number;
  /** Inject a cache backing store (composes with `@primandproper/cache`); defaults to an in-memory one. */
  cache?: Cache<string>;
}

/**
 * A {@link SecretSource} decorator that adds short-TTL memoization and in-flight de-duplication in
 * front of any inner source. It composes with `@primandproper/cache` (an {@link InMemoryCache} by
 * default) so repeated reads of the same key don't each cost a remote round trip, and concurrent
 * reads of the same key collapse to a single upstream call — which also blunts a Secret Manager
 * blip, since a still-cached value keeps serving. Only positive results are cached: a miss is
 * re-checked every time so a newly-created secret is seen promptly.
 */
export class CachingSecretSource implements SecretSource {
  readonly #inner: SecretSource;
  readonly #cache: Cache<string>;
  readonly #inflight = new Map<string, Promise<string | undefined>>();

  constructor(
    inner: SecretSource,
    options: CachingSecretSourceOptions = {},
    deps: ObservabilityDeps = {},
  ) {
    this.#inner = inner;
    this.#cache =
      options.cache ??
      provideCache<string>(
        { provider: "memory", expiryMs: options.ttlMs ?? DEFAULT_SECRET_TTL_MS },
        deps,
      );
  }

  get(key: string): Promise<string | undefined> {
    // Register the in-flight promise synchronously so concurrent callers share one upstream call.
    const pending = this.#inflight.get(key);
    if (pending !== undefined) {
      return pending;
    }
    const tracked = this.#resolve(key).finally(() => {
      this.#inflight.delete(key);
    });
    this.#inflight.set(key, tracked);
    return tracked;
  }

  async #resolve(key: string): Promise<string | undefined> {
    const cached = await this.#cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const value = await this.#inner.get(key);
    if (value !== undefined) {
      await this.#cache.set(key, value);
    }
    return value;
  }

  getRequired(key: string): Promise<string> {
    return getRequired(this, key);
  }

  ping(): Promise<void> {
    return this.#inner.ping();
  }

  /** Closes both the cache and the wrapped source. */
  async close(): Promise<void> {
    await this.#cache.close();
    await this.#inner.close();
  }
}
