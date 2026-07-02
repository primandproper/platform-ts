import { z } from "zod";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Universal logging config. Replaces the Go `env:`-tagged struct + ozzo validation. */
export const LoggingConfigSchema = z.object({
  level: z.enum(LOG_LEVELS).default("info"),
  name: z.string().min(1).default("app"),
});

export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
export type LoggingConfigInput = z.input<typeof LoggingConfigSchema>;

/**
 * Metrics config. The `noop` default is safe with no OTel SDK registered — it falls back to
 * the global meter, which is a no-op until an `@opentelemetry/sdk-metrics` MeterProvider is
 * installed via `metrics.setGlobalMeterProvider(...)`. Selecting `otel` is identical at the
 * config level; it documents intent and lets a caller inject a provider explicitly.
 */
export const MetricsConfigSchema = z.object({
  provider: z.enum(["noop", "otel"]).default("noop"),
  /** Instrumentation/meter name reported to the backend. */
  name: z.string().min(1).default("app"),
});

export type MetricsConfig = z.infer<typeof MetricsConfigSchema>;
export type MetricsConfigInput = z.input<typeof MetricsConfigSchema>;

/**
 * Tracing config. Same story as metrics: `noop` falls back to the global tracer (a no-op
 * until a `@opentelemetry/sdk-trace-*` TracerProvider is registered via
 * `trace.setGlobalTracerProvider(...)` or an injected provider).
 */
export const TracingConfigSchema = z.object({
  provider: z.enum(["noop", "otel"]).default("noop"),
  /** Instrumentation/tracer name reported to the backend. */
  name: z.string().min(1).default("app"),
});

export type TracingConfig = z.infer<typeof TracingConfigSchema>;
export type TracingConfigInput = z.input<typeof TracingConfigSchema>;

/**
 * Profiling config. Continuous profiling is a server-only concern in practice, so the
 * default is `noop` and the browser always resolves to a noop profiler regardless of this
 * value. `pyroscope` documents intent and selects the Node pyroscope provider, which the
 * caller wires up themselves (see `providers/profiling.node.ts`).
 */
export const ProfilingConfigSchema = z.object({
  provider: z.enum(["noop", "pyroscope"]).default("noop"),
  /** Application name reported to the profiling backend. */
  name: z.string().min(1).default("app"),
  /** Profiling backend server URL, when a provider needs one (e.g. pyroscope). */
  serverUrl: z.string().url().optional(),
});

export type ProfilingConfig = z.infer<typeof ProfilingConfigSchema>;
export type ProfilingConfigInput = z.input<typeof ProfilingConfigSchema>;
