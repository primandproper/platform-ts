import {
  makeMetrics,
  type Metrics,
  type ObservabilityDeps,
} from "@primandproper/observability";

type Counter = ReturnType<Metrics["counter"]>;

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
