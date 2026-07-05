import {
  makeMetrics,
  makeObserver,
  type Logger,
  type Metrics,
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

type Counter = ReturnType<Metrics["counter"]>;
type Gauge = ReturnType<Metrics["gauge"]>;

/** Numeric encoding of {@link State} for the `circuitbreaking.state` gauge. */
const STATE_CODE: Record<State, number> = {
  closed: 0,
  "half-open": 1,
  open: 2,
};

/**
 * The metric instruments every partition shares: a transition counter tagged with the `from`/`to`
 * states, a gauge tracking the current numeric state, and a counter of rejected acquisitions.
 */
interface CircuitInstruments {
  transitions: Counter;
  state: Gauge;
  rejections: Counter;
}

/** Mints the shared circuit-breaking instruments, defaulting to the noop meter. */
function circuitInstruments(deps: PartitionedDeps): CircuitInstruments {
  const metrics = makeMetrics(o11yName, deps.metrics);
  return {
    transitions: metrics.counter("circuitbreaking.transitions", {
      description: "Circuit breaker state transitions, tagged with from/to states.",
    }),
    state: metrics.gauge("circuitbreaking.state", {
      description: "Current circuit breaker state (closed=0, half_open=1, open=2).",
    }),
    rejections: metrics.counter("circuitbreaking.rejections", {
      description: "Guarded attempts rejected by an open or exhausted circuit breaker.",
    }),
  };
}

/** One partition's breaker: the actual closed/open/half-open state machine. */
class PartitionBreaker implements CircuitBreaker {
  readonly #config: CircuitBreakerConfig;
  readonly #now: () => number;
  readonly #logger: Logger;
  readonly #instruments: CircuitInstruments;
  readonly #key: string;

  #state: State = "closed";
  #failures = 0;
  #openedAt = 0;
  #halfOpenAt = 0;
  #halfOpenAttempts = 0;

  constructor(
    key: string,
    config: CircuitBreakerConfig,
    now: () => number,
    logger: Logger,
    instruments: CircuitInstruments,
  ) {
    this.#key = key;
    this.#config = config;
    this.#now = now;
    this.#logger = logger;
    this.#instruments = instruments;
  }

  /**
   * Gates one guarded attempt. **This mutates**: in half-open it consumes a probe slot, so it is
   * an acquisition, not a side-effect-free predicate — call it exactly once per guarded attempt
   * (a speculative double-check burns a probe). Returns `true` when the attempt may proceed.
   */
  canProceed(): boolean {
    if (this.#state === "open" && this.#cooldownElapsed()) {
      this.#toHalfOpen();
    } else if (this.#state === "half-open" && this.#halfOpenStalled()) {
      // Probes were all handed out but none resolved within a cooldown window (e.g. a hung probe
      // that never calls succeeded()/failed()). Without this the partition wedges in half-open
      // forever; force it back open and restart the cooldown so fresh probes are minted later.
      this.#open();
    }

    if (this.#state === "half-open") {
      if (this.#halfOpenAttempts >= this.#config.halfOpenMaxAttempts) {
        this.#reject();
        return false;
      }
      this.#halfOpenAttempts += 1;
      return true;
    }

    if (this.#state === "closed") {
      return true;
    }

    this.#reject();
    return false;
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

  // True once every probe slot is spent and a full cooldown has elapsed since going half-open with
  // no probe resolving it — the signal to force back open rather than wedge.
  #halfOpenStalled(): boolean {
    return (
      this.#halfOpenAttempts >= this.#config.halfOpenMaxAttempts &&
      this.#now() - this.#halfOpenAt >= this.#config.openDurationMs
    );
  }

  #open(): void {
    const from = this.#state;
    this.#state = "open";
    this.#openedAt = this.#now();
    this.#halfOpenAttempts = 0;
    this.#logger.warn(`circuit opened for partition "${this.#key}"`);
    this.#recordTransition(from, "open");
  }

  #toHalfOpen(): void {
    const from = this.#state;
    this.#state = "half-open";
    this.#halfOpenAt = this.#now();
    this.#halfOpenAttempts = 0;
    this.#logger.info(`circuit half-open for partition "${this.#key}"`);
    this.#recordTransition(from, "half-open");
  }

  #close(): void {
    const from = this.#state;
    this.#state = "closed";
    this.#failures = 0;
    this.#halfOpenAttempts = 0;
    this.#logger.info(`circuit recovered to closed for partition "${this.#key}"`);
    this.#recordTransition(from, "closed");
  }

  #recordTransition(from: State, to: State): void {
    this.#instruments.transitions.add(1, { partition: this.#key, from, to });
    this.#instruments.state.record(STATE_CODE[to], { partition: this.#key });
  }

  #reject(): void {
    this.#instruments.rejections.add(1, { partition: this.#key });
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
  readonly #instruments: CircuitInstruments;
  readonly #partitions = new Map<string, PartitionBreaker>();

  constructor(config: CircuitBreakerConfig, deps: PartitionedDeps = {}) {
    this.#config = config;
    this.#now = deps.now ?? (() => Date.now());
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
    this.#instruments = circuitInstruments(deps);
  }

  /** Returns the breaker for the given partition key, creating it on first use. */
  forPartition(key: string): CircuitBreaker {
    let breaker = this.#partitions.get(key);
    if (breaker === undefined) {
      breaker = new PartitionBreaker(
        key,
        this.#config,
        this.#now,
        this.#logger,
        this.#instruments,
      );
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
