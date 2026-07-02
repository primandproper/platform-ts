import { metrics, trace, type Meter, type Tracer } from "@opentelemetry/api";

import type { Logger } from "./logger.js";
import type { Observer } from "./observer.js";

export type { Meter, Tracer };

/** Minimal tracer-provider surface so callers don't depend on the full OTel SDK. */
export interface TracerProvider {
  getTracer(name: string): Tracer;
}

/** Minimal meter-provider surface so callers don't depend on the full OTel SDK. */
export interface MeterProvider {
  getMeter(name: string): Meter;
}

/**
 * Default providers backed by the global OTel API. With no SDK registered these are the
 * OTel no-op implementations, so observability is always safe to call.
 */
export const noopTracerProvider: TracerProvider = {
  getTracer: (name) => trace.getTracer(name),
};

export const noopMeterProvider: MeterProvider = {
  getMeter: (name) => metrics.getMeter(name),
};

/**
 * The observability bundle every provider constructor accepts. All fields are optional;
 * use {@link ensureLogger} and the noop providers to fill the gaps.
 */
export interface ObservabilityDeps {
  logger?: Logger;
  tracer?: TracerProvider;
  metrics?: MeterProvider;
  /**
   * A fully-built {@link Observer} to use as-is. When present, a consumer uses it directly and
   * ignores `logger`/`tracer`/`metrics` above — the injector already composed them. Primarily a
   * test seam: pass a `RecordingObserver` to assert what a component observed. Compose with
   * `deps.observer ?? makeObserver(o11yName, deps)` in a consumer constructor.
   */
  observer?: Observer;
}
