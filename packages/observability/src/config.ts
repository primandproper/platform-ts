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
 * Metrics config. `otel` (the default) resolves to the injected or globally-registered
 * `@opentelemetry/sdk-metrics` MeterProvider, so metrics flow automatically once an SDK is
 * installed via `metrics.setGlobalMeterProvider(...)`. `noop` forces a genuinely inert meter
 * regardless of any registered global — use it to hard-disable metrics.
 */
export const MetricsConfigSchema = z.object({
  provider: z.enum(["noop", "otel"]).default("otel"),
});

export type MetricsConfig = z.infer<typeof MetricsConfigSchema>;
export type MetricsConfigInput = z.input<typeof MetricsConfigSchema>;

/**
 * Tracing config. Same story as metrics: `otel` (the default) resolves to the injected or
 * globally-registered `@opentelemetry/sdk-trace-*` TracerProvider; `noop` forces a genuinely
 * inert tracer regardless of any registered global.
 */
export const TracingConfigSchema = z.object({
  provider: z.enum(["noop", "otel"]).default("otel"),
});

export type TracingConfig = z.infer<typeof TracingConfigSchema>;
export type TracingConfigInput = z.input<typeof TracingConfigSchema>;

/**
 * Profiling config. Continuous profiling is a server-only concern in practice, so the
 * default is `noop` and the browser always resolves to a noop profiler regardless of this
 * value.
 *
 * `pyroscope` is **experimental and currently unimplemented** — selecting it warns loudly and
 * runs as a no-op until a caller wires up a real profiler (see `providers/profiling.node.ts`).
 */
export const ProfilingConfigSchema = z.object({
  provider: z
    .enum(["noop", "pyroscope"])
    .default("noop")
    .describe(
      "noop | pyroscope (experimental, unimplemented — runs as a warning-only noop)",
    ),
  /** Application name reported to the profiling backend. */
  name: z.string().min(1).default("app"),
  /** Profiling backend server URL, when a provider needs one (e.g. pyroscope). */
  serverUrl: z.string().url().optional(),
});

export type ProfilingConfig = z.infer<typeof ProfilingConfigSchema>;
export type ProfilingConfigInput = z.input<typeof ProfilingConfigSchema>;
