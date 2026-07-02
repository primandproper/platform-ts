import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type { CircuitBreaker } from "../circuitbreaking.js";
import type { CircuitBreakerConfig } from "../config.js";

const o11yName = "circuitbreaking";

/** Injectable clock + observability. `now` is overridable for deterministic tests. */
export interface PartitionedDeps extends ObservabilityDeps {
  now?: () => number;
}

type State = "closed" | "open" | "half-open";

/** One partition's breaker: the actual closed/open/half-open state machine. */
class PartitionBreaker implements CircuitBreaker {
  readonly #config: CircuitBreakerConfig;
  readonly #now: () => number;
  readonly #logger: Logger;
  readonly #key: string;

  #state: State = "closed";
  #failures = 0;
  #openedAt = 0;
  #halfOpenAttempts = 0;

  constructor(
    key: string,
    config: CircuitBreakerConfig,
    now: () => number,
    logger: Logger,
  ) {
    this.#key = key;
    this.#config = config;
    this.#now = now;
    this.#logger = logger;
  }

  canProceed(): boolean {
    if (this.#state === "open" && this.#cooldownElapsed()) {
      this.#toHalfOpen();
    }

    if (this.#state === "half-open") {
      if (this.#halfOpenAttempts >= this.#config.halfOpenMaxAttempts) {
        return false;
      }
      this.#halfOpenAttempts += 1;
      return true;
    }

    return this.#state === "closed";
  }

  succeeded(): void {
    if (this.#state === "half-open") {
      this.#close();
      return;
    }
    this.#failures = 0;
  }

  failed(): void {
    if (this.#state === "half-open") {
      this.#open();
      return;
    }

    this.#failures += 1;
    if (this.#failures >= this.#config.failureThreshold) {
      this.#open();
    }
  }

  #cooldownElapsed(): boolean {
    return this.#now() - this.#openedAt >= this.#config.openDurationMs;
  }

  #open(): void {
    this.#state = "open";
    this.#openedAt = this.#now();
    this.#halfOpenAttempts = 0;
    this.#logger.warn(`circuit opened for partition "${this.#key}"`);
  }

  #toHalfOpen(): void {
    this.#state = "half-open";
    this.#halfOpenAttempts = 0;
    this.#logger.debug(`circuit half-open for partition "${this.#key}"`);
  }

  #close(): void {
    this.#state = "closed";
    this.#failures = 0;
    this.#halfOpenAttempts = 0;
    this.#logger.debug(`circuit closed for partition "${this.#key}"`);
  }
}

const DEFAULT_PARTITION = "default";

/**
 * A circuit breaker that keeps an independent breaker per partition key (e.g. per downstream
 * host or route), lazily created on first use. The manager itself implements
 * {@link CircuitBreaker} by delegating to a shared `"default"` partition; call
 * {@link PartitionedCircuitBreaker.forPartition} to address a specific key.
 *
 * The analogue of the Go platform's partitioned circuit breaker.
 */
export class PartitionedCircuitBreaker implements CircuitBreaker {
  readonly #config: CircuitBreakerConfig;
  readonly #now: () => number;
  readonly #observer: Observer;
  readonly #logger: Logger;
  readonly #partitions = new Map<string, PartitionBreaker>();

  constructor(config: CircuitBreakerConfig, deps: PartitionedDeps = {}) {
    this.#config = config;
    this.#now = deps.now ?? (() => Date.now());
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  /** Returns the breaker for the given partition key, creating it on first use. */
  forPartition(key: string): CircuitBreaker {
    let breaker = this.#partitions.get(key);
    if (breaker === undefined) {
      breaker = new PartitionBreaker(key, this.#config, this.#now, this.#logger);
      this.#partitions.set(key, breaker);
    }
    return breaker;
  }

  canProceed(): boolean {
    return this.forPartition(DEFAULT_PARTITION).canProceed();
  }

  succeeded(): void {
    this.forPartition(DEFAULT_PARTITION).succeeded();
  }

  failed(): void {
    this.forPartition(DEFAULT_PARTITION).failed();
  }
}
