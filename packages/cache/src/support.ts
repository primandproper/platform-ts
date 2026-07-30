import {
  makeMetrics,
  type Metrics,
  type ObservabilityDeps,
} from "@primandproper/observability";

import type { CacheSetOptions } from "./cache.js";

type Counter = ReturnType<Metrics["counter"]>;

/**
 * Normalizes a constructor-supplied expiry to "milliseconds, or no expiry", applying the same
 * non-positive-means-absent rule the per-write override uses. Providers call this once in their
 * constructor so `undefined` thereafter unambiguously means "this cache does not expire entries".
 */
export function normalizeExpiryMs(expiryMs: number | undefined): number | undefined {
  return expiryMs !== undefined && expiryMs > 0 ? expiryMs : undefined;
}

/**
 * The one place the {@link CacheSetOptions.ttlMs} contract is implemented: a positive per-write
 * TTL wins, anything else falls back to the cache's configured expiry. Every provider routes
 * through this so they cannot quietly disagree about what `ttlMs: 0` means.
 */
export function resolveTtlMs(
  opts: CacheSetOptions | undefined,
  defaultExpiryMs: number | undefined,
): number | undefined {
  const override = opts?.ttlMs;
  return override !== undefined && override > 0 ? override : defaultExpiryMs;
}

/**
 * The `cache.hits` / `cache.misses` counter pair every provider mints in its constructor. The
 * meter is registered under the component's o11y name so instruments group with its spans/logs;
 * per-operation duration/outcome metrics come for free from the observer's `run`.
 */
export interface CacheInstruments {
  hits: Counter;
  misses: Counter;
}

/** Builds the `{o11yName}.hits` / `{o11yName}.misses` counters, defaulting to the noop meter. */
export function cacheInstruments(
  o11yName: string,
  deps: ObservabilityDeps | undefined,
): CacheInstruments {
  const metrics = makeMetrics(o11yName, deps?.metrics);
  return {
    hits: metrics.counter(`${o11yName}.hits`, {
      description: "Count of cache reads that returned a value.",
    }),
    misses: metrics.counter(`${o11yName}.misses`, {
      description: "Count of cache reads that returned no value.",
    }),
  };
}
