import type {
  Counter,
  Gauge,
  Histogram,
  MetricOptions,
  UpDownCounter,
} from "@opentelemetry/api";

import { MetricsConfigSchema, type MetricsConfigInput } from "./config.js";
import {
  defaultMeterProvider,
  type MeterProvider,
  noopMeterProvider,
  type ObservabilityDeps,
} from "./observability.js";

/**
 * A small typed facade over an OTel {@link MeterProvider}. It exists so call-site code can
 * mint instruments without reaching for `provider.getMeter(...).createX(...)` every time,
 * and so a missing provider degrades to the global/noop meter instead of throwing.
 *
 * Every instrument is the unchanged OTel type, so anything in `@opentelemetry/api` continues
 * to work; this is convenience, not a wall.
 */
export interface Metrics {
  /** A monotonic counter — `add(value)` with non-negative increments. */
  counter(name: string, options?: MetricOptions): Counter;
  /** An up/down counter — `add(value)` accepting negative increments. */
  upDownCounter(name: string, options?: MetricOptions): UpDownCounter;
  /** A histogram — `record(value)` for value distributions. */
  histogram(name: string, options?: MetricOptions): Histogram;
  /** A synchronous gauge — `record(value)` for the latest reading. */
  gauge(name: string, options?: MetricOptions): Gauge;
}

/**
 * Builds a {@link Metrics} facade over the given meter provider. Defaults to the
 * {@link defaultMeterProvider}, so instruments are always safe to create and record — a no-op
 * until an SDK is registered, then live.
 */
export function makeMetrics(
  name: string,
  provider: MeterProvider = defaultMeterProvider,
): Metrics {
  const meter = provider.getMeter(name);
  return {
    counter: (instrumentName, options) => meter.createCounter(instrumentName, options),
    upDownCounter: (instrumentName, options) =>
      meter.createUpDownCounter(instrumentName, options),
    histogram: (instrumentName, options) =>
      meter.createHistogram(instrumentName, options),
    gauge: (instrumentName, options) => meter.createGauge(instrumentName, options),
  };
}

/**
 * Provider factory mirroring the Go platform's `Provide*` and the other packages'
 * `provide*`. `provider: "otel"` (the default) resolves to the injected provider, or the
 * globally-registered OTel meter provider (a no-op until an SDK is registered). `provider:
 * "noop"` forces a genuinely inert meter, ignoring any injected or global provider.
 *
 * To wire a real backend on Node, register an SDK provider once at startup and either set it
 * global or inject it here:
 *
 * ```ts
 * import { MeterProvider } from "@opentelemetry/sdk-metrics";
 * import { metrics } from "@opentelemetry/api";
 *
 * const sdk = new MeterProvider({ readers: [...] });
 * metrics.setGlobalMeterProvider(sdk);          // picked up by the otel default, or
 * provideMeterProvider({ provider: "otel" }, { metrics: sdk }); // inject explicitly
 * ```
 *
 * The SDK is deliberately not a dependency of this package: pinning it would couple every
 * consumer to one SDK version, and the global API fallback already does the right thing.
 */
export function provideMeterProvider(
  config?: MetricsConfigInput,
  deps?: ObservabilityDeps,
): MeterProvider {
  const cfg = MetricsConfigSchema.parse(config ?? {});
  if (cfg.provider === "noop") {
    return noopMeterProvider;
  }
  return deps?.metrics ?? defaultMeterProvider;
}
