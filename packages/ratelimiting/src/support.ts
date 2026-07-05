import {
  makeMetrics,
  type Metrics,
  type ObservabilityDeps,
} from "@primandproper/observability";

type Counter = ReturnType<Metrics["counter"]>;

/**
 * The allowed/denied decision counters every rate-limiter provider mints in its constructor,
 * registered under the component's o11y name so they group with its spans and logs.
 */
export interface RateLimiterInstruments {
  allowed: Counter;
  denied: Counter;
  /** Backend failures (e.g. a Redis error) that forced the fail-open/closed fallback. */
  errors: Counter;
}

/**
 * Builds the `{o11yName}.allowed` / `.denied` / `.errors` counters, defaulting to the noop meter.
 */
export function rateLimiterInstruments(
  o11yName: string,
  deps: ObservabilityDeps | undefined,
): RateLimiterInstruments {
  const metrics = makeMetrics(o11yName, deps?.metrics);
  return {
    allowed: metrics.counter(`${o11yName}.allowed`, {
      description: "Count of requests permitted by the rate limiter.",
    }),
    denied: metrics.counter(`${o11yName}.denied`, {
      description: "Count of requests denied by the rate limiter.",
    }),
    errors: metrics.counter(`${o11yName}.errors`, {
      description:
        "Count of backend failures that triggered the fail-open/closed fallback.",
    }),
  };
}
