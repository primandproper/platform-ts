import {
  makeMetrics,
  type Metrics,
  type ObservabilityDeps,
} from "@primandproper/observability";

type Counter = ReturnType<Metrics["counter"]>;

/**
 * The contention counter every distributed-lock provider mints in its constructor. It ticks once
 * per contention event: an `acquire` that found the key already held, or a `release`/`refresh`
 * that found its lease lost (expired or taken over by another holder). The increment is tagged
 * with `operation` (`acquire` | `release` | `refresh`) so the three cases stay distinguishable.
 * The meter is registered under the provider's o11y name so the instrument groups with its spans
 * and logs.
 */
export interface LockInstruments {
  contention: Counter;
}

/** Builds the `distributedlock.contention` counter, defaulting to the noop meter. */
export function lockInstruments(
  o11yName: string,
  deps: ObservabilityDeps | undefined,
): LockInstruments {
  const metrics = makeMetrics(o11yName, deps?.metrics);
  return {
    contention: metrics.counter("distributedlock.contention", {
      description:
        "Count of lock-contention events, tagged by operation (acquire/release/refresh).",
    }),
  };
}
