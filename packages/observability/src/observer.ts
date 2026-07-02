import { type SpanOptions, type Tracer } from "@opentelemetry/api";

import { ensureLogger, type Logger } from "./logger.js";
import { noopTracerProvider, type ObservabilityDeps } from "./observability.js";
import { newOperation, type Operation } from "./operation.js";
import { withSpan } from "./tracing.js";

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
   */
  begin(name: string, options?: SpanOptions): Operation;
  /**
   * Runs `fn` inside an active span named `name`, ending the span once `fn` settles. A thrown
   * error is recorded on the span and its status set to ERROR before re-throwing (see
   * {@link withSpan}); to also log it, route through `op.error`/`op.acknowledge`. The active
   * span means nested `begin`/`run` calls parent correctly. This is the ergonomic default —
   * reach for {@link Observer.begin} only when a callback doesn't fit. Do not call `op.end()`
   * inside `fn`; `run` owns the span lifecycle.
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

  constructor(name: string, deps?: ObservabilityDeps) {
    this.#logger = ensureLogger(deps?.logger).child(name);
    this.#tracer = (deps?.tracer ?? noopTracerProvider).getTracer(name);
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
    return withSpan(
      this.#tracer,
      name,
      (span) => fn(newOperation(this.#logger, span)),
      options,
    );
  }
}

/**
 * Builds an {@link Observer} named `name`, drawing its logger and tracer from `deps` and
 * falling back to the noop logger and the global/noop tracer. Mirrors {@link makeMetrics}; the
 * analogue of platform-go's `NewObserver`.
 */
export function makeObserver(name: string, deps?: ObservabilityDeps): Observer {
  return new NamedObserver(name, deps);
}
