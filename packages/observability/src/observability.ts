import {
  createNoopMeter,
  INVALID_SPAN_CONTEXT,
  metrics,
  trace,
  type Meter,
  type Span,
  type Tracer,
} from "@opentelemetry/api";

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
 * Default providers backed by the global OTel API. With no SDK registered these resolve to the
 * OTel no-op implementations, but once an SDK is registered globally (the common Node setup)
 * spans and metrics flow through automatically. These are the fallbacks used everywhere a caller
 * doesn't inject an explicit provider.
 */
export const defaultTracerProvider: TracerProvider = {
  getTracer: (name) => trace.getTracer(name),
};

export const defaultMeterProvider: MeterProvider = {
  getMeter: (name) => metrics.getMeter(name),
};

/**
 * Genuinely inert providers, independent of any globally-registered SDK. Selected by
 * `provider: "noop"` when a caller wants to force observability off regardless of what else is
 * wired up (the {@link defaultTracerProvider}/{@link defaultMeterProvider} would otherwise
 * pick up a registered global SDK).
 */
// A non-recording span over an invalid context: every mutator is a no-op and it emits nowhere.
const nonRecordingSpan: Span = trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
const noopTracer: Tracer = {
  startSpan: () => nonRecordingSpan,
  startActiveSpan: (...args: unknown[]) => {
    const fn = args[args.length - 1] as (span: Span) => unknown;
    return fn(nonRecordingSpan);
  },
};
export const noopTracerProvider: TracerProvider = {
  getTracer: () => noopTracer,
};

const noopMeter = createNoopMeter();
export const noopMeterProvider: MeterProvider = {
  getMeter: () => noopMeter,
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
