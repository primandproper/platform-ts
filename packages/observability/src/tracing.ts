import {
  type Span,
  SpanStatusCode,
  type SpanOptions,
  type Tracer,
} from "@opentelemetry/api";
import { messageOf } from "@primandproper/errors";

import { TracingConfigSchema, type TracingConfigInput } from "./config.js";
import {
  noopTracerProvider,
  type ObservabilityDeps,
  type TracerProvider,
} from "./observability.js";

/**
 * Provider factory mirroring the other packages' `provide*`. Both `noop` and `otel` resolve
 * to the global OTel tracer provider — a no-op until an SDK is registered — unless an
 * explicit provider is injected via `deps.tracer`.
 *
 * To wire a real backend on Node, register an SDK provider once at startup and either set it
 * global or inject it here:
 *
 * ```ts
 * import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
 * import { trace } from "@opentelemetry/api";
 *
 * const sdk = new NodeTracerProvider({ ... });
 * sdk.register();                                  // picked up by the noop fallback, or
 * provideTracerProvider({ provider: "otel" }, { tracer: sdk }); // inject explicitly
 * ```
 *
 * The SDK is deliberately not a dependency of this package — see `provideMeterProvider` for
 * the same reasoning.
 */
export function provideTracerProvider(
  config?: TracingConfigInput,
  deps?: ObservabilityDeps,
): TracerProvider {
  TracingConfigSchema.parse(config ?? {});
  return deps?.tracer ?? noopTracerProvider;
}

/**
 * Runs `fn` inside a new active span, ending the span automatically. On a thrown error the
 * exception is recorded and the span status is set to `ERROR` before re-throwing; on success
 * the status is left `UNSET` (the OTel convention — `OK` is reserved for explicit assertions).
 *
 * Works for both sync and async `fn`: a returned promise is awaited so the span ends only
 * once the async work settles. Safe against the noop tracer.
 */
export function withSpan<T>(
  tracer: Tracer,
  name: string,
  fn: (span: Span) => T | Promise<T>,
  options?: SpanOptions,
): Promise<T> {
  const start = (span: Span): Promise<T> =>
    Promise.resolve()
      .then(() => fn(span))
      .then(
        (result) => {
          span.end();
          return result;
        },
        (err: unknown) => {
          span.recordException(err as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: messageOf(err),
          });
          span.end();
          throw err;
        },
      );

  return options === undefined
    ? tracer.startActiveSpan(name, start)
    : tracer.startActiveSpan(name, options, start);
}
