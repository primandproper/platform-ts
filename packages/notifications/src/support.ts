import {
  makeMetrics,
  type Metrics,
  type ObservabilityDeps,
} from "@primandproper/observability";

type Counter = ReturnType<Metrics["counter"]>;

/**
 * The `_sends` / `_errors` counter pair every Go notifier and sender mints in its constructor
 * (`metrics.EnsureMetricsProvider(...).NewInt64Counter(o11yName + "_sends"/"_errors")`). The
 * meter is registered under the component's o11y name so instruments group with its spans/logs.
 */
export interface SenderInstruments {
  sends: Counter;
  errors: Counter;
}

/** Builds the `{o11yName}_sends` / `{o11yName}_errors` counters, defaulting to the noop meter. */
export function senderInstruments(
  o11yName: string,
  deps: ObservabilityDeps | undefined,
): SenderInstruments {
  const metrics = makeMetrics(o11yName, deps?.metrics);
  return {
    sends: metrics.counter(`${o11yName}_sends`),
    errors: metrics.counter(`${o11yName}_errors`),
  };
}
