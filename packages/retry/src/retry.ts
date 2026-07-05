import type { RetryConfig } from "./config.js";

/** Structured key/values attached to a retry log line. Mirrors the platform `LogValues`. */
export type RetryLogValues = Record<string, unknown>;

/** Minimal logging surface so retry stays dependency-free; any platform `Logger` satisfies it. */
export interface RetryLogger {
  debug(message: string, values?: RetryLogValues): void;
  warn(message: string, values?: RetryLogValues): void;
}

/**
 * Decides whether a thrown error is worth retrying. `attempt` is 1-based (the failure that just
 * happened). Returning `false` surfaces the error immediately without further attempts — this is
 * how callers keep 4xx client errors from being retried alongside 503s. Defaults to retrying
 * every error.
 */
export type ShouldRetry = (error: unknown, attempt: number) => boolean;

/** Injectable runtime + logger. `sleep`/`random`/`now` are overridable for deterministic tests. */
export interface RetryDeps {
  logger?: RetryLogger;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Monotonic-ish clock for the elapsed-time budget. Defaults to `Date.now`. */
  now?: () => number;
  /** Predicate gating whether an error is retried. Defaults to "retry everything". */
  shouldRetry?: ShouldRetry;
}

/** Per-run options. `signal` cancels an in-flight retry loop (including the backoff sleep). */
export interface RunOptions {
  signal?: AbortSignal | undefined;
}

/** Runs an operation under a retry strategy. */
export interface Policy {
  run<T>(operation: () => Promise<T>, options?: RunOptions): Promise<T>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The error to reject/throw with when a signal aborts — its `reason` when that is an Error. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("retry aborted");
}

/**
 * The jittered exponential backoff for a given zero-based retry index, in milliseconds. Exposed
 * standalone so callers that roll their own reconnect loop (eventstream) reuse the exact formula
 * instead of duplicating it.
 */
export function backoffDelay(
  config: Pick<RetryConfig, "baseDelayMs" | "maxDelayMs" | "jitter">,
  retryIndex: number,
  random: () => number = Math.random,
): number {
  const exponential = config.baseDelayMs * 2 ** retryIndex;
  const capped = Math.min(exponential, config.maxDelayMs);
  const jitterSpan = capped * config.jitter;
  return Math.round(capped - jitterSpan + random() * jitterSpan);
}

class ExponentialBackoffPolicy implements Policy {
  readonly #config: RetryConfig;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #shouldRetry: ShouldRetry;
  readonly #logger: RetryLogger | undefined;

  constructor(config: RetryConfig, deps: RetryDeps) {
    this.#config = config;
    this.#sleep = deps.sleep ?? defaultSleep;
    this.#random = deps.random ?? Math.random;
    this.#now = deps.now ?? Date.now;
    this.#shouldRetry = deps.shouldRetry ?? (() => true);
    this.#logger = deps.logger;
  }

  async run<T>(operation: () => Promise<T>, options: RunOptions = {}): Promise<T> {
    const { signal } = options;
    const start = this.#now();
    let attempt = 0;
    for (;;) {
      if (signal?.aborted) {
        throw abortReason(signal);
      }
      try {
        return await operation();
      } catch (err) {
        attempt += 1;

        // A cancellation that landed mid-operation is terminal, not retryable.
        if (signal?.aborted) {
          throw abortReason(signal);
        }
        if (!this.#shouldRetry(err, attempt)) {
          this.#logger?.debug("retry giving up: error is not retryable", {
            attempt,
            error: err,
          });
          throw err;
        }
        if (attempt >= this.#config.maxAttempts) {
          this.#logger?.warn(`retry exhausted after ${String(attempt)} attempts`, {
            attempts: attempt,
            error: err,
          });
          throw err;
        }

        const delay = backoffDelay(this.#config, attempt - 1, this.#random);
        if (this.#config.maxElapsedMs > 0) {
          const elapsed = this.#now() - start;
          if (elapsed + delay >= this.#config.maxElapsedMs) {
            this.#logger?.warn(
              `retry deadline exceeded after ${String(attempt)} attempts`,
              { attempts: attempt, elapsedMs: elapsed, error: err },
            );
            throw err;
          }
        }

        this.#logger?.debug(
          `retrying (attempt ${String(attempt)}) after ${String(delay)}ms`,
          { attempt, delayMs: delay, error: err },
        );
        await this.#delay(delay, signal);
      }
    }
  }

  /** Sleeps for `ms`, rejecting early with the abort reason if `signal` fires. */
  #delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (signal === undefined) {
      return this.#sleep(ms);
    }
    if (signal.aborted) {
      return Promise.reject(abortReason(signal));
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#sleep(ms).then(
        () => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          reject(
            err instanceof Error ? err : new Error("retry sleep failed", { cause: err }),
          );
        },
      );
    });
  }
}

/** Builds an exponential-backoff {@link Policy}. The analogue of Go's `NewExponentialBackoffPolicy`. */
export function exponentialBackoff(config: RetryConfig, deps: RetryDeps = {}): Policy {
  return new ExponentialBackoffPolicy(config, deps);
}
