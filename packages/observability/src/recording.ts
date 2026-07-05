import { type Span, type Tracer } from "@opentelemetry/api";

import { noopLogger, type Logger, type LogValues } from "./logger.js";
import { noopTracerProvider } from "./observability.js";
import { type Observer } from "./observer.js";
import { type Operation } from "./operation.js";

/** Which pillar(s) a value was observed on. `both` is the default {@link Operation.set} path. */
export type Pillar = "both" | "span" | "log";

/** A single value observed during a recorded run. `seq` is globally monotonic across operations. */
export interface Observation {
  seq: number;
  operation: string;
  key: string;
  value: unknown;
  pillar: Pillar;
}

/** An error routed through `op.error`/`op.acknowledge` during a recorded run. */
export interface RecordedError {
  seq: number;
  operation: string;
  err: unknown;
  description: string;
}

/**
 * A settled {@link Observer.run}, captured so tests can assert the duration/outcome metrics the
 * real {@link makeObserver} auto-records. `durationMs` is always `>= 0` but not otherwise
 * meaningful under the recording double.
 */
export interface RecordedRun {
  seq: number;
  operation: string;
  outcome: "ok" | "error";
  durationMs: number;
}

/**
 * An {@link Operation} that captures observations instead of emitting them. Created by
 * {@link RecordingObserver}; you rarely construct one directly.
 */
class RecordingOperation implements Operation {
  readonly name: string;
  readonly #observations: Observation[];
  readonly #errors: RecordedError[];
  readonly #nextSeq: () => number;
  readonly #span: Span;
  #recorded = false;

  constructor(
    name: string,
    observations: Observation[],
    errors: RecordedError[],
    nextSeq: () => number,
  ) {
    this.name = name;
    this.#observations = observations;
    this.#errors = errors;
    this.#nextSeq = nextSeq;
    this.#span = noopTracerProvider.getTracer("recording").startSpan(name);
  }

  #record(key: string, value: unknown, pillar: Pillar): void {
    this.#observations.push({
      seq: this.#nextSeq(),
      operation: this.name,
      key,
      value,
      pillar,
    });
  }

  set(key: string, value: unknown): Operation {
    this.#record(key, value, "both");
    return this;
  }

  setValues(values: LogValues): Operation {
    for (const [key, value] of Object.entries(values)) {
      this.#record(key, value, "both");
    }
    return this;
  }

  spanOnly(key: string, value: unknown): Operation {
    this.#record(key, value, "span");
    return this;
  }

  logOnly(key: string, value: unknown): Operation {
    this.#record(key, value, "log");
    return this;
  }

  logger(): Logger {
    return noopLogger;
  }

  span(): Span {
    return this.#span;
  }

  error(err: unknown, description: string): unknown {
    this.#recorded = true;
    this.#errors.push({ seq: this.#nextSeq(), operation: this.name, err, description });
    return err;
  }

  acknowledge(err: unknown, description: string): void {
    this.#recorded = true;
    this.#errors.push({ seq: this.#nextSeq(), operation: this.name, err, description });
  }

  recorded(): boolean {
    return this.#recorded;
  }

  end(): void {}
}

/**
 * A drop-in {@link Observer} for unit tests that records every observation rather than
 * logging or tracing it. Assert what a unit observed — keys, values, the pillar each landed
 * on, and their relative order — instead of scraping log output or hand-rolling span mocks.
 *
 * It deliberately does not reproduce platform-go's matcher DSL; the captured
 * {@link RecordingObserver.observations} array composes directly with vitest's `toContainEqual`
 * and friends, with a few conveniences below for the common assertions.
 */
export class RecordingObserver implements Observer {
  readonly #observations: Observation[] = [];
  readonly #errors: RecordedError[] = [];
  readonly #runs: RecordedRun[] = [];
  #seq = 0;

  readonly #nextSeq = (): number => this.#seq++;

  logger(): Logger {
    return noopLogger;
  }

  tracer(): Tracer {
    return noopTracerProvider.getTracer("recording");
  }

  begin(name: string): Operation {
    return new RecordingOperation(name, this.#observations, this.#errors, this.#nextSeq);
  }

  async run<T>(name: string, fn: (op: Operation) => T | Promise<T>): Promise<T> {
    const op = this.begin(name);
    const start = performance.now();
    let outcome: RecordedRun["outcome"] = "ok";
    try {
      return await fn(op);
    } catch (err) {
      outcome = "error";
      throw err;
    } finally {
      this.#runs.push({
        seq: this.#nextSeq(),
        operation: name,
        outcome,
        durationMs: performance.now() - start,
      });
      op.end();
    }
  }

  /** The full ordered observation stream across every operation. */
  get observations(): readonly Observation[] {
    return this.#observations;
  }

  /** Errors routed through `op.error`/`op.acknowledge`, in order. */
  get errors(): readonly RecordedError[] {
    return this.#errors;
  }

  /**
   * Every settled {@link run}, in order — the recording analogue of the duration/outcome
   * metrics {@link makeObserver} auto-records. Assert `outcome` to prove a unit's `run` failed
   * (and thus emits an error-count metric) without a real meter.
   */
  get runs(): readonly RecordedRun[] {
    return this.#runs;
  }

  /** Observed keys, in order. */
  keys(): string[] {
    return this.#observations.map((o) => o.key);
  }

  /** Merged key→value across all operations, last write winning. */
  data(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const o of this.#observations) {
      out[o.key] = o.value;
    }
    return out;
  }

  /** Whether `key` was observed at all. */
  observed(key: string): boolean {
    return this.#observations.some((o) => o.key === key);
  }

  /** Every observation for `key`, in order. */
  forKey(key: string): Observation[] {
    return this.#observations.filter((o) => o.key === key);
  }

  /** Every observation recorded by the named operation, in order. */
  forOperation(name: string): Observation[] {
    return this.#observations.filter((o) => o.operation === name);
  }

  /**
   * Whether `keys` were observed in the given relative order. Other observations may interleave;
   * only the order of these keys is asserted.
   */
  observedInOrder(...keys: string[]): boolean {
    let i = 0;
    for (const o of this.#observations) {
      if (i < keys.length && o.key === keys[i]) {
        i++;
      }
    }
    return i === keys.length;
  }

  /** Clears all captured observations, errors, and runs. */
  reset(): void {
    this.#observations.length = 0;
    this.#errors.length = 0;
    this.#runs.length = 0;
    this.#seq = 0;
  }
}

/** Builds a {@link RecordingObserver}. Mirrors {@link makeObserver}; the analogue of Go's `NewRecordingObserver`. */
export function makeRecordingObserver(): RecordingObserver {
  return new RecordingObserver();
}
