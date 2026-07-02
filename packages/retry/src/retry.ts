import type { RetryConfig } from "./config.js";

/** Minimal logging surface so retry stays dependency-free; any platform `Logger` satisfies it. */
export interface RetryLogger {
  debug(message: string): void;
}

/** Injectable runtime + logger. `sleep`/`random` are overridable for deterministic tests. */
export interface RetryDeps {
  logger?: RetryLogger;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** Runs an operation under a retry strategy. */
export interface Policy {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

class ExponentialBackoffPolicy implements Policy {
  readonly #config: RetryConfig;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #logger: RetryLogger | undefined;

  constructor(config: RetryConfig, deps: RetryDeps) {
    this.#config = config;
    this.#sleep = deps.sleep ?? defaultSleep;
    this.#random = deps.random ?? Math.random;
    this.#logger = deps.logger;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await operation();
      } catch (err) {
        attempt += 1;
        if (attempt >= this.#config.maxAttempts) {
          throw err;
        }
        const delay = this.#delayFor(attempt - 1);
        this.#logger?.debug(
          `retrying (attempt ${String(attempt)}) after ${String(delay)}ms`,
        );
        await this.#sleep(delay);
      }
    }
  }

  #delayFor(retryIndex: number): number {
    const exponential = this.#config.baseDelayMs * 2 ** retryIndex;
    const capped = Math.min(exponential, this.#config.maxDelayMs);
    const jitterSpan = capped * this.#config.jitter;
    return Math.round(capped - jitterSpan + this.#random() * jitterSpan);
  }
}

/** Builds an exponential-backoff {@link Policy}. The analogue of Go's `NewExponentialBackoffPolicy`. */
export function exponentialBackoff(config: RetryConfig, deps: RetryDeps = {}): Policy {
  return new ExponentialBackoffPolicy(config, deps);
}
