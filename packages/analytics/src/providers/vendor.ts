import {
  makeMetrics,
  makeObserver,
  type Logger,
  type Metrics,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type { EventContext, EventProperties, EventReporter } from "../analytics.js";

const o11yName = "analytics";

type Counter = ReturnType<Metrics["counter"]>;

/**
 * Default deadline (ms) for {@link VendorReporter.flush}/{@link VendorReporter.shutdown}. Flush-on-
 * shutdown is exactly where a wedged vendor SDK would otherwise stall process exit, so it must be
 * bounded; abandoning a slow flush loses at most the last buffered batch.
 */
export const DEFAULT_ANALYTICS_TIMEOUT_MS = 10_000;

/** Per-reporter overrides for the flush/shutdown deadlines. */
export interface VendorReporterOptions {
  flushTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

/**
 * The raw, may-throw operations a vendor SDK adapter exposes. Each vendor's `provide*` factory
 * builds one of these over its SDK client (Node or browser); {@link VendorReporter} wraps it with
 * the best-effort, never-throw contract every provider shares. Keeping this boundary universal lets
 * the reporter logic stay in one place while the SDK imports live only in the `*.node.ts` /
 * `*.browser.ts` factories.
 */
export interface VendorSink {
  track(
    event: string,
    properties: EventProperties | undefined,
    context: EventContext | undefined,
  ): void;
  identify(userId: string, traits: EventProperties | undefined): void;
  page(
    name: string,
    properties: EventProperties | undefined,
    context: EventContext | undefined,
  ): void;
  screen(
    name: string,
    properties: EventProperties | undefined,
    context: EventContext | undefined,
  ): void;
  /** Flushes buffered events without releasing the client. */
  flush(): Promise<void> | void;
  /** Flushes and releases the client. The sink is unusable afterwards. */
  shutdown(): Promise<void> | void;
}

/**
 * Wraps a {@link VendorSink} so every call honours the {@link EventReporter} contract: a failure in
 * the underlying SDK is logged via the injected observer and swallowed, never propagated —
 * analytics is observation, not a transaction, and must never take down the calling path.
 */
export class VendorReporter implements EventReporter {
  readonly #sink: VendorSink;
  readonly #provider: string;
  readonly #logger: Logger;
  readonly #sent: Counter;
  readonly #dropped: Counter;
  readonly #flushTimeoutMs: number;
  readonly #shutdownTimeoutMs: number;

  constructor(
    provider: string,
    sink: VendorSink,
    deps: ObservabilityDeps = {},
    options: VendorReporterOptions = {},
  ) {
    this.#sink = sink;
    this.#provider = provider;
    const observer: Observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = observer.logger();
    const metrics = makeMetrics(o11yName, deps.metrics);
    this.#sent = metrics.counter("analytics.events.sent", {
      description: "Analytics events enqueued for delivery.",
    });
    this.#dropped = metrics.counter("analytics.events.dropped", {
      description:
        "Analytics events dropped by a synchronous or background-delivery failure.",
    });
    this.#flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_ANALYTICS_TIMEOUT_MS;
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_ANALYTICS_TIMEOUT_MS;
  }

  track(event: string, properties?: EventProperties, context?: EventContext): void {
    try {
      this.#sink.track(event, properties, context);
      this.#sent.add(1, { provider: this.#provider });
    } catch (err) {
      this.#drop("track", err, { event });
    }
  }

  identify(userId: string, traits?: EventProperties): void {
    try {
      this.#sink.identify(userId, traits);
      this.#sent.add(1, { provider: this.#provider });
    } catch (err) {
      // The userId is a user identifier: kept out of telemetry per the PII stance (INST-7).
      this.#drop("identify", err);
    }
  }

  page(name: string, properties?: EventProperties, context?: EventContext): void {
    try {
      this.#sink.page(name, properties, context);
      this.#sent.add(1, { provider: this.#provider });
    } catch (err) {
      this.#drop("page", err, { name });
    }
  }

  screen(name: string, properties?: EventProperties, context?: EventContext): void {
    try {
      this.#sink.screen(name, properties, context);
      this.#sent.add(1, { provider: this.#provider });
    } catch (err) {
      this.#drop("screen", err, { name });
    }
  }

  /**
   * Records a background delivery failure surfaced by a buffered vendor SDK's async sender. These
   * failures (posthog-node and @segment/analytics-node emit them on their client `error` event)
   * never reach the synchronous call path, so without this hook they are silent: count the drop and
   * log it. The `provide*` node factories wire this to the SDK client's error listener.
   */
  onBackgroundError(err: unknown): void {
    this.#drop("delivery", err);
  }

  flush(): Promise<void> {
    return this.#bounded("flush", () => this.#sink.flush(), this.#flushTimeoutMs);
  }

  shutdown(): Promise<void> {
    return this.#bounded(
      "shutdown",
      () => this.#sink.shutdown(),
      this.#shutdownTimeoutMs,
    );
  }

  /**
   * Runs a flush/shutdown against a deadline. A sink error is logged and swallowed (best-effort);
   * a sink that outlives `timeoutMs` is abandoned with a warn so it can never stall process exit.
   */
  async #bounded(
    operation: "flush" | "shutdown",
    work: () => Promise<void> | void,
    timeoutMs: number,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          resolve("timeout");
        }, timeoutMs);
      });
      const done = Promise.resolve(work()).then(() => "done" as const);
      if ((await Promise.race([done, deadline])) === "timeout") {
        this.#logger
          .with({ provider: this.#provider, operation, timeoutMs })
          .warn(
            `analytics ${operation} exceeded its ${String(timeoutMs)}ms deadline; abandoning`,
          );
      }
    } catch (err) {
      this.#log(operation, err);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  /** Counts a dropped event and logs the failure that caused it. */
  #drop(operation: string, err: unknown, values?: EventProperties): void {
    this.#dropped.add(1, { provider: this.#provider });
    this.#log(operation, err, values);
  }

  #log(operation: string, err: unknown, values?: EventProperties): void {
    this.#logger
      .with({ provider: this.#provider, operation, ...values })
      .error(`analytics ${operation} failed`, err);
  }
}
