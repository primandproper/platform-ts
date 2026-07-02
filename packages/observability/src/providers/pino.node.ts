import type { Span } from "@opentelemetry/api";
import { pino, type Logger as PinoBase } from "pino";

import type { LoggingConfig } from "../config.js";
import type { Logger, LogValues } from "../logger.js";

/** Node default provider: a {@link Logger} backed by pino. */
export class PinoLogger implements Logger {
  readonly #base: PinoBase;

  constructor(base: PinoBase) {
    this.#base = base;
  }

  debug(message: string): void {
    this.#base.debug(message);
  }

  info(message: string): void {
    this.#base.info(message);
  }

  warn(message: string): void {
    this.#base.warn(message);
  }

  error(whatWasHappening: string, err?: unknown): void {
    this.#base.error({ err }, whatWasHappening);
  }

  with(values: LogValues): Logger {
    return new PinoLogger(this.#base.child(values));
  }

  child(name: string): Logger {
    return new PinoLogger(this.#base.child({ name }));
  }

  withSpan(span: Span): Logger {
    const ctx = span.spanContext();
    return this.with({ traceId: ctx.traceId, spanId: ctx.spanId });
  }
}

export function pinoLogger(config: LoggingConfig): Logger {
  return new PinoLogger(pino({ level: config.level, name: config.name }));
}
