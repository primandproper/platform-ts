import type { Span } from "@opentelemetry/api";

import type { LoggingConfig, LogLevel } from "../config.js";
import type { Logger, LogValues } from "../logger.js";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Browser default provider: a {@link Logger} backed by `console`. Bindings accumulate via
 * `with`/`child` and ride along on every line, mirroring the pino provider's shape.
 */
export class ConsoleLogger implements Logger {
  readonly #level: LogLevel;
  readonly #name: string;
  readonly #bindings: LogValues;

  constructor(config: LoggingConfig, bindings: LogValues = {}) {
    this.#level = config.level;
    this.#name = config.name;
    this.#bindings = bindings;
  }

  debug(message: string): void {
    this.#emit("debug", message);
  }

  info(message: string): void {
    this.#emit("info", message);
  }

  warn(message: string): void {
    this.#emit("warn", message);
  }

  error(whatWasHappening: string, err?: unknown): void {
    this.#emit("error", whatWasHappening, err);
  }

  with(values: LogValues): Logger {
    return new ConsoleLogger(this.#config(), { ...this.#bindings, ...values });
  }

  child(name: string): Logger {
    return new ConsoleLogger({ level: this.#level, name }, this.#bindings);
  }

  withSpan(span: Span): Logger {
    const ctx = span.spanContext();
    return this.with({ traceId: ctx.traceId, spanId: ctx.spanId });
  }

  #config(): LoggingConfig {
    return { level: this.#level, name: this.#name };
  }

  #emit(level: LogLevel, message: string, err?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#level]) {
      return;
    }
    const fields = {
      name: this.#name,
      ...this.#bindings,
      ...(err === undefined ? {} : { err }),
    };
    console[level](`[${this.#name}] ${message}`, fields);
  }
}

export function consoleLogger(config: LoggingConfig): Logger {
  return new ConsoleLogger(config);
}
