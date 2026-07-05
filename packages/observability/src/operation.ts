import { type AttributeValue, type Span, SpanStatusCode } from "@opentelemetry/api";
import { messageOf } from "@primandproper/errors";

import { ensureLogger, type Logger, type LogValues } from "./logger.js";

/**
 * A per-call observability bag, ported from platform-go's `Operation`. Its defining idea is
 * fan-out: a value observed once via {@link Operation.set} lands on BOTH the span and a
 * span-linked logger, so trace and logs never drift apart. Obtain one from
 * {@link Observer.begin} or {@link Observer.run}; mutators return the operation so calls
 * chain. End it with {@link Operation.end} (or let {@link Observer.run} end it for you).
 */
export interface Operation {
  /** Attaches the value to BOTH the span and the logger — the default, fan-out path. */
  set(key: string, value: unknown): Operation;
  /** Attaches every entry to both the span and the logger. */
  setValues(values: LogValues): Operation;
  /** Escape hatch: attach to the span only. */
  spanOnly(key: string, value: unknown): Operation;
  /** Escape hatch: attach to the logger only. */
  logOnly(key: string, value: unknown): Operation;
  /** The span-linked logger, carrying everything `set`/`logOnly` has attached so far. */
  logger(): Logger;
  /** The underlying span, for OTel APIs this facade deliberately doesn't wrap. */
  span(): Span;
  /**
   * Records the error on the span (exception + ERROR status), logs it with `description`, and
   * returns it so the caller can `throw op.error(err, "...")`.
   */
  error(err: unknown, description: string): unknown;
  /** Like {@link error} but returns nothing — for a handled error you do not re-throw. */
  acknowledge(err: unknown, description: string): void;
  /**
   * Whether an error has already been recorded on this operation via {@link error} or
   * {@link acknowledge}. {@link Observer.run} checks this so it doesn't double-record (or
   * double-log) an error the callback already handled.
   */
  recorded(): boolean;
  /** Ends the span. Pair it with {@link Observer.begin} in a `try`/`finally`. */
  end(): void;
}

/**
 * Coerces an arbitrary observed value into something a span attribute accepts. Primitives
 * pass through; everything else is JSON-stringified (falling back to `String`) so a `set`
 * never throws on, say, an object. The logger keeps the original value untouched.
 */
function toAttributeValue(value: unknown): AttributeValue {
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return value;
    case "bigint":
    case "symbol":
    case "function":
      return value.toString();
    case "undefined":
      return "undefined";
    default:
      if (value === null) {
        return "null";
      }
      try {
        return JSON.stringify(value);
      } catch {
        return Object.prototype.toString.call(value);
      }
  }
}

class SpanOperation implements Operation {
  #logger: Logger;
  readonly #span: Span;
  #recorded = false;

  constructor(logger: Logger, span: Span) {
    this.#span = span;
    this.#logger = ensureLogger(logger).withSpan(span);
  }

  set(key: string, value: unknown): Operation {
    this.#span.setAttribute(key, toAttributeValue(value));
    this.#logger = this.#logger.with({ [key]: value });
    return this;
  }

  setValues(values: LogValues): Operation {
    for (const [key, value] of Object.entries(values)) {
      this.#span.setAttribute(key, toAttributeValue(value));
    }
    this.#logger = this.#logger.with(values);
    return this;
  }

  spanOnly(key: string, value: unknown): Operation {
    this.#span.setAttribute(key, toAttributeValue(value));
    return this;
  }

  logOnly(key: string, value: unknown): Operation {
    this.#logger = this.#logger.with({ [key]: value });
    return this;
  }

  logger(): Logger {
    return this.#logger;
  }

  span(): Span {
    return this.#span;
  }

  error(err: unknown, description: string): unknown {
    this.#recordError(err, description);
    return err;
  }

  acknowledge(err: unknown, description: string): void {
    this.#recordError(err, description);
  }

  recorded(): boolean {
    return this.#recorded;
  }

  end(): void {
    this.#span.end();
  }

  #recordError(err: unknown, description: string): void {
    this.#recorded = true;
    this.#span.recordException(err as Error);
    this.#span.setStatus({
      code: SpanStatusCode.ERROR,
      message: messageOf(err),
    });
    this.#logger.error(description, err);
  }
}

/**
 * Builds an {@link Operation} over an already-started span, linking the span into the logger
 * once. Low-level: prefer {@link Observer.begin}/{@link Observer.run}, which own the span
 * lifecycle. Exposed for advanced wiring and test doubles.
 */
export function newOperation(logger: Logger, span: Span): Operation {
  return new SpanOperation(logger, span);
}
