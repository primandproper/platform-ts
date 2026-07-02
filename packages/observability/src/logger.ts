import type { Span } from "@opentelemetry/api";

/** Structured key/value pairs attached to a log line. */
export type LogValues = Record<string, unknown>;

/**
 * The universal logging contract. Every provider — pino on Node, console in the browser —
 * implements exactly this, so call-site code is identical regardless of where it runs.
 */
export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  /** Logs an error alongside a description of what was happening when it occurred. */
  error(whatWasHappening: string, err?: unknown): void;
  /** Returns a logger that attaches the given values to every subsequent line. */
  with(values: LogValues): Logger;
  /** Returns a named child logger. */
  child(name: string): Logger;
  /** Returns a logger that attaches the span's trace and span IDs. */
  withSpan(span: Span): Logger;
}

class NoopLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  with(): Logger {
    return this;
  }
  child(): Logger {
    return this;
  }
  withSpan(): Logger {
    return this;
  }
}

/** A logger that discards everything. Shared singleton. */
export const noopLogger: Logger = new NoopLogger();

/**
 * Returns the given logger, or the noop logger when none is provided. The analogue of the
 * Go platform's `EnsureLogger()` nil-guard: downstream code never has to null-check.
 */
export function ensureLogger(logger?: Logger): Logger {
  return logger ?? noopLogger;
}
