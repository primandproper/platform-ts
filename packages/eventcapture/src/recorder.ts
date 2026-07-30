import { PlatformError } from "@primandproper/errors";
import {
  makeMetrics,
  makeObserver,
  type Logger,
  type Metrics,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import { RingBuffer } from "./ring-buffer.js";
import type { Sink } from "./sink.js";

// Derived from the observability facade rather than imported from `@opentelemetry/api`, so this
// package does not pin an OTel version of its own — the house pattern.
type Counter = ReturnType<Metrics["counter"]>;
type Histogram = ReturnType<Metrics["histogram"]>;

/** Caps the in-flight event buffer when `bufferSize` is not supplied. */
export const DEFAULT_BUFFER_SIZE = 1024;
/** The drain loop's flush cadence, in milliseconds, when `flushIntervalMs` is not supplied. */
export const DEFAULT_FLUSH_INTERVAL_MS = 5_000;

/** Names the recorder's logger, spans, and instruments. */
const O11Y_NAME = "eventcapture";

/** Thrown by {@link Recorder.close} when its signal aborts before the tail is drained. */
export const CLOSE_ABORTED_CODE = "eventcapture/close-aborted";

/**
 * The hooks a composition wires into a {@link Recorder}. Every one runs on the drain chain, off
 * the hot path — `record()` itself never touches them.
 *
 * `E` is inferred from the recorder these configure, so nothing here needs a type argument.
 * (platform-go splits "generic option" from "option that needs the event type" because Go
 * cannot infer a type argument from a call's result type; TypeScript can, so this port keeps
 * one options bag.)
 */
export interface RecorderHooks<E> {
  /**
   * Projects each event into the record written to the sink — typically a wire-shaped object
   * with a stable field layout — instead of the raw event. Returning `undefined` skips the
   * write for that event.
   */
  transform?: (event: E) => unknown;
  /** Runs for every consumed event. The composition point for an {@link Aggregator}'s `observe`. */
  observe?: (event: E) => void;
  /**
   * Runs on every flush tick and once more during the final drain (with `final` set). `emit`
   * queues a record to be written through the sink with the recorder's error handling; the
   * queued records are written after the hook returns, so `emit` stays synchronous. The
   * composition point for emitting an {@link Aggregator}'s completed buckets.
   */
  onFlush?: (now: Date, final: boolean, emit: (record: unknown) => void) => void;
  /**
   * Polled on each flush to report observations an aggregation dropped for exceeding its key
   * bound — pass an {@link Aggregator}'s `takeOverflow`. Without it a full aggregator discards
   * observations silently, since the recorder cannot see inside a composition whose key and
   * counter types belong to the caller.
   */
  overflow?: () => number;
  /** Clock for bucket boundaries and flush timestamps. Defaults to `() => new Date()`. */
  now?: () => Date;
}

/** Everything {@link Recorder} accepts: the buffering knobs plus the composition hooks. */
export interface RecorderOptions<E> extends RecorderHooks<E> {
  /** Caps the in-flight event buffer. A full buffer drops (and counts) new events. */
  bufferSize?: number;
  /** Flush cadence in milliseconds. */
  flushIntervalMs?: number;
  /**
   * Whether each consumed event is itself written to the sink. Set `false` for compositions
   * that only emit derived records (e.g. aggregate rollups via `onFlush`) — the difference
   * between a usable aggregation and one that doubles your write volume.
   */
  rawRecords?: boolean;
}

/**
 * The bridge between a hot path and a {@link Sink}.
 *
 * {@link Recorder.record} is a non-blocking bounded-buffer push — a full buffer drops the event
 * and counts it, so capture never slows a request — and a single drain chain consumes the
 * buffer on the microtask queue, writing records and running the hooks. Sink failures are
 * counted and logged, never surfaced: the request that produced the event has long since been
 * answered.
 *
 * Because nothing here fails loudly, the instruments are the only way to learn that capture has
 * broken. Watch `eventcapture.sink.errors` (the sink is rejecting records),
 * `eventcapture.records.dropped` (producers are outrunning the drain — raise `bufferSize` or
 * lower `flushIntervalMs`), and `eventcapture.aggregation.overflow` (a composition hit its key
 * bound).
 */
export class Recorder<E> {
  readonly #sink: Sink;
  readonly #buffer: RingBuffer<E>;
  readonly #observer: Observer;
  readonly #logger: Logger;
  readonly #raw: boolean;
  readonly #now: () => Date;
  readonly #transform: ((event: E) => unknown) | undefined;
  readonly #observe: ((event: E) => void) | undefined;
  readonly #onFlush:
    | ((now: Date, final: boolean, emit: (record: unknown) => void) => void)
    | undefined;
  readonly #overflow: (() => number) | undefined;

  readonly #written: Counter;
  readonly #droppedCounter: Counter;
  readonly #overflowCounter: Counter;
  readonly #sinkErrors: Counter;
  readonly #hookErrors: Counter;
  readonly #flushLatency: Histogram;

  #dropped = 0;
  /** High-water mark of drops already reported to the instrument. */
  #reportedDropped = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  /** Serializes every sink interaction — drains, flushes, and the final close. */
  #chain: Promise<void> = Promise.resolve();
  #drainScheduled = false;
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(sink: Sink, options: RecorderOptions<E> = {}, deps?: ObservabilityDeps) {
    this.#sink = sink;
    this.#buffer = new RingBuffer<E>(options.bufferSize ?? DEFAULT_BUFFER_SIZE);
    this.#raw = options.rawRecords ?? true;
    this.#now = options.now ?? ((): Date => new Date());
    this.#transform = options.transform;
    this.#observe = options.observe;
    this.#onFlush = options.onFlush;
    this.#overflow = options.overflow;

    this.#observer = deps?.observer ?? makeObserver(O11Y_NAME, deps);
    this.#logger = this.#observer.logger();

    const metrics = makeMetrics(O11Y_NAME, deps?.metrics);
    this.#written = metrics.counter("eventcapture.records.written", {
      description: "Records successfully written through the capture sink.",
    });
    this.#droppedCounter = metrics.counter("eventcapture.records.dropped", {
      description:
        "Events dropped because the capture buffer was full or the recorder closed.",
    });
    this.#overflowCounter = metrics.counter("eventcapture.aggregation.overflow", {
      description: "Observations an aggregation dropped for exceeding its key bound.",
    });
    this.#sinkErrors = metrics.counter("eventcapture.sink.errors", {
      description: "Capture sink failures, by stage.",
    });
    this.#hookErrors = metrics.counter("eventcapture.hook.errors", {
      description: "Composition hook failures, by stage.",
    });
    this.#flushLatency = metrics.histogram("eventcapture.flush.latency", {
      unit: "ms",
      description: "Duration of a capture flush.",
    });

    const intervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.#timer = setInterval(() => {
      void this.#enqueue(() => this.#runFlush(false));
    }, intervalMs);
    // A capture pipeline must not be the reason a process refuses to exit — the owner's `close`
    // is what flushes the tail, not a timer nobody is waiting on. `unref` is Node-only; in the
    // browser `setInterval` returns a number and there is nothing to unref.
    unref(this.#timer);
  }

  /** Events dropped so far because the buffer was full (or the recorder was already closed). */
  get dropped(): number {
    return this.#dropped;
  }

  /** Events currently buffered, waiting for the drain chain. */
  get buffered(): number {
    return this.#buffer.size;
  }

  /**
   * Hands one event to the drain chain. Never blocks and never throws: when the buffer is full
   * (or the recorder is closed) the event is dropped and counted instead.
   *
   * The event is held by reference until it is consumed — mutating it afterwards changes what
   * gets written. Record a copy, or project one in `transform`, if the caller reuses the object.
   */
  record(event: E): void {
    if (this.#closed || !this.#buffer.push(event)) {
      // Counted with a plain increment and reported to the instrument at flush time, so the hot
      // path never pays for an instrument call.
      this.#dropped++;
      return;
    }
    if (!this.#drainScheduled) {
      this.#drainScheduled = true;
      void this.#enqueue(async () => {
        this.#drainScheduled = false;
        await this.#drain();
      });
    }
  }

  /**
   * Drains what is buffered and flushes the sink now, rather than waiting for the next tick.
   * Never rejects — sink failures are counted and logged like any other.
   */
  flush(): Promise<void> {
    return this.#enqueue(async () => {
      await this.#drain();
      await this.#runFlush(false);
    });
  }

  /**
   * Stops accepting events, drains the tail, runs a final flush, and closes the sink. Safe to
   * call more than once; later calls await the first (and ignore their `signal`).
   *
   * This is the one traced operation in the package — flushes are not traced, since a root span
   * every few seconds parented to nothing is noise, but abandoning a drain at shutdown loses
   * captured events, which a shutdown trace wants accounted for.
   *
   * @param signal Abandons the drain when it aborts, rejecting with a `PlatformError` coded
   *   {@link CLOSE_ABORTED_CODE}. The tail is then lost, which is why it is worth reporting.
   */
  close(signal?: AbortSignal): Promise<void> {
    this.#closing ??= this.#doClose(signal);
    return this.#closing;
  }

  async #doClose(signal?: AbortSignal): Promise<void> {
    this.#closed = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }

    await this.#observer.run("eventcapture.close", async (op) => {
      const drained = this.#enqueue(async () => {
        await this.#drain();
        await this.#runFlush(true);
        try {
          await this.#sink.close();
        } catch (err) {
          this.#sinkErrors.add(1, { stage: "close" });
          this.#logger.error("closing capture sink", err);
        }
      });

      if (signal === undefined) {
        await drained;
        return;
      }
      const abort = abortWatch(signal);
      try {
        await Promise.race([drained, abort.rejected]);
      } catch (err) {
        throw op.error(err, "draining capture buffer before close");
      } finally {
        abort.cancel();
      }
    });
  }

  /**
   * Appends `task` to the single-consumer chain. Tasks handle their own failures; the `catch`
   * is a backstop so one unexpected rejection cannot wedge every later drain.
   */
  #enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.#chain.then(task, task);
    this.#chain = next.catch((err: unknown) => {
      this.#logger.error("capture drain task failed", err);
    });
    return this.#chain;
  }

  async #drain(): Promise<void> {
    while (this.#buffer.size > 0) {
      await this.#consume(this.#buffer.shift() as E);
    }
  }

  async #consume(event: E): Promise<void> {
    if (this.#raw) {
      let record: unknown = event;
      if (this.#transform !== undefined) {
        try {
          record = this.#transform(event);
        } catch (err) {
          this.#hookErrors.add(1, { stage: "transform" });
          this.#logger.error("transforming captured event", err);
          record = undefined;
        }
      }
      if (record !== undefined && record !== null) {
        await this.#write(record, "writing captured event");
      }
    }

    if (this.#observe !== undefined) {
      try {
        this.#observe(event);
      } catch (err) {
        this.#hookErrors.add(1, { stage: "observe" });
        this.#logger.error("observing captured event", err);
      }
    }
  }

  /** Pushes one record through the sink, counting the outcome either way. */
  async #write(record: unknown, description: string): Promise<void> {
    try {
      await this.#sink.write(record);
      this.#written.add(1);
    } catch (err) {
      this.#sinkErrors.add(1, { stage: "write" });
      this.#logger.error(description, err);
    }
  }

  /** Runs the flush hook, reports the drop and overflow counters, and flushes the sink. */
  async #runFlush(final: boolean): Promise<void> {
    const start = performance.now();
    try {
      if (this.#onFlush !== undefined) {
        const emitted: unknown[] = [];
        try {
          this.#onFlush(this.#now(), final, (record) => emitted.push(record));
        } catch (err) {
          this.#hookErrors.add(1, { stage: "onFlush" });
          this.#logger.error("running capture flush hook", err);
        }
        for (const record of emitted) {
          await this.#write(record, "writing flush-emitted record");
        }
      }

      this.#reportDropped();
      this.#reportOverflow();

      try {
        await this.#sink.flush();
      } catch (err) {
        this.#sinkErrors.add(1, { stage: "flush" });
        this.#logger.error("flushing capture sink", err);
      }
    } finally {
      this.#flushLatency.record(performance.now() - start, { final });
    }
  }

  #reportDropped(): void {
    const total = this.#dropped;
    if (total <= this.#reportedDropped) {
      return;
    }
    const delta = total - this.#reportedDropped;
    this.#reportedDropped = total;
    this.#droppedCounter.add(delta);
    this.#logger.info("captured events dropped: buffer full", { dropped: delta, total });
  }

  #reportOverflow(): void {
    if (this.#overflow === undefined) {
      return;
    }
    let overflow = 0;
    try {
      overflow = this.#overflow();
    } catch (err) {
      this.#hookErrors.add(1, { stage: "overflow" });
      this.#logger.error("polling aggregation overflow", err);
      return;
    }
    if (overflow > 0) {
      this.#overflowCounter.add(overflow);
      this.#logger.info("aggregation observations dropped: key bound reached", {
        overflow,
      });
    }
  }
}

/**
 * A promise that rejects when `signal` aborts, plus the `cancel` that detaches its listener —
 * without which every `close(signal)` would leave a listener on a signal the caller may keep.
 */
function abortWatch(signal: AbortSignal): {
  rejected: Promise<never>;
  cancel: () => void;
} {
  let cancel = (): void => {
    /* replaced below once there is a listener to detach */
  };
  const rejected = new Promise<never>((_resolve, reject) => {
    const fail = (): void => {
      reject(
        new PlatformError(
          CLOSE_ABORTED_CODE,
          "capture buffer was still draining when close was abandoned",
          { cause: signal.reason },
        ),
      );
    };
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
    cancel = (): void => {
      signal.removeEventListener("abort", fail);
    };
  });
  // Nothing else awaits this promise when the drain wins the race; without a handler that
  // becomes an unhandled rejection if the signal aborts afterwards.
  rejected.catch(() => undefined);
  return {
    rejected,
    cancel: () => {
      cancel();
    },
  };
}

/**
 * Detaches a Node timer from the event loop when the runtime supports it. Typed loosely
 * because `setInterval` returns a `Timeout` under `@types/node` and a `number` in the browser.
 */
function unref(timer: unknown): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    const maybeUnref = (timer as { unref?: unknown }).unref;
    if (typeof maybeUnref === "function") {
      (maybeUnref as () => void).call(timer);
    }
  }
}
