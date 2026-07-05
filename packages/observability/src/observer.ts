import {
  type Counter,
  type Histogram,
  type Span,
  SpanStatusCode,
  type SpanOptions,
  type Tracer,
} from "@opentelemetry/api";
import { messageOf } from "@primandproper/errors";

import { ensureLogger, type Logger } from "./logger.js";
import { makeMetrics, type Metrics } from "./metrics.js";
import { defaultTracerProvider, type ObservabilityDeps } from "./observability.js";
import { newOperation, type Operation } from "./operation.js";

/** Outcome tag on the auto-recorded run metrics. */
type Outcome = "ok" | "error";

/**
 * A per-component bundle of a named logger and tracer — the ported `Observer`. A component
 * holds one of these instead of juggling a separate logger and tracer, and opens each
 * instrumented method with {@link Observer.begin} or {@link Observer.run} to get a per-call
 * {@link Operation} whose observations fan out to span and logs at once.
 *
 * Span names are explicit. platform-go derives them from the caller's stack frame, which does
 * not survive bundling/minification in TypeScript, so the name is passed in.
 */
export interface Observer {
  /** The component's named logger. */
  logger(): Logger;
  /** The component's named tracer. */
  tracer(): Tracer;
  /**
   * Starts a span named `name` and returns an {@link Operation} whose logger is already linked
   * to it. The span is NOT made active, so spans started inside it will not parent to it — use
   * {@link Observer.run} when you need nested spans to nest. Always `end()` the operation,
   * ideally in a `finally`.
   *
   * Unlike {@link Observer.run}, `begin` does not auto-record duration/outcome metrics — the
   * caller owns the lifecycle, so it owns the timing too.
   */
  begin(name: string, options?: SpanOptions): Operation;
  /**
   * Runs `fn` inside an active span named `name`, ending the span once `fn` settles, and
   * auto-records an operation-duration histogram and an outcome counter tagged by operation
   * name — so a component that only reaches for `run` gets timing and error-rate metrics with
   * zero extra wiring.
   *
   * A thrown error is recorded on the span (exception + ERROR status) and logged exactly once
   * with the operation name — unless the callback already routed it through `op.error`/
   * `op.acknowledge`, in which case `run` leaves the single recording it made untouched. The
   * active span means nested `begin`/`run` calls parent correctly. This is the ergonomic
   * default — reach for {@link Observer.begin} only when a callback doesn't fit. Do not call
   * `op.end()` inside `fn`; `run` owns the span lifecycle.
   */
  run<T>(
    name: string,
    fn: (op: Operation) => T | Promise<T>,
    options?: SpanOptions,
  ): Promise<T>;
}

class NamedObserver implements Observer {
  readonly #logger: Logger;
  readonly #tracer: Tracer;
  readonly #duration: Histogram;
  readonly #count: Counter;

  constructor(name: string, deps?: ObservabilityDeps) {
    this.#logger = ensureLogger(deps?.logger).child(name);
    this.#tracer = (deps?.tracer ?? defaultTracerProvider).getTracer(name);

    const metrics: Metrics = makeMetrics(name, deps?.metrics);
    this.#duration = metrics.histogram("operation.duration", {
      unit: "ms",
      description: "Duration of an instrumented operation, by name and outcome.",
    });
    this.#count = metrics.counter("operation.count", {
      description: "Count of instrumented operations, by name and outcome.",
    });
  }

  logger(): Logger {
    return this.#logger;
  }

  tracer(): Tracer {
    return this.#tracer;
  }

  begin(name: string, options?: SpanOptions): Operation {
    const span =
      options === undefined
        ? this.#tracer.startSpan(name)
        : this.#tracer.startSpan(name, options);
    return newOperation(this.#logger, span);
  }

  run<T>(
    name: string,
    fn: (op: Operation) => T | Promise<T>,
    options?: SpanOptions,
  ): Promise<T> {
    const exec = (span: Span): Promise<T> => {
      const op = newOperation(this.#logger, span);
      const start = performance.now();
      return Promise.resolve()
        .then(() => fn(op))
        .then(
          (result) => {
            this.#finish(span, name, start, "ok");
            return result;
          },
          (err: unknown) => {
            // Only record when the callback didn't already route the error through
            // op.error/op.acknowledge — otherwise the exception event, ERROR status, and error
            // log would all land twice (OBS-2/OBS-3).
            if (!op.recorded()) {
              span.recordException(err as Error);
              span.setStatus({ code: SpanStatusCode.ERROR, message: messageOf(err) });
              op.logger().error(`operation "${name}" failed`, err);
            }
            this.#finish(span, name, start, "error");
            throw err;
          },
        );
    };

    return options === undefined
      ? this.#tracer.startActiveSpan(name, exec)
      : this.#tracer.startActiveSpan(name, options, exec);
  }

  #finish(span: Span, name: string, start: number, outcome: Outcome): void {
    const attributes = { operation: name, outcome };
    this.#duration.record(performance.now() - start, attributes);
    this.#count.add(1, attributes);
    span.end();
  }
}

/**
 * Builds an {@link Observer} named `name`, drawing its logger, tracer, and meter from `deps`
 * and falling back to the noop logger and the global/noop tracer and meter. Mirrors
 * {@link makeMetrics}; the analogue of platform-go's `NewObserver`.
 */
export function makeObserver(name: string, deps?: ObservabilityDeps): Observer {
  return new NamedObserver(name, deps);
}
