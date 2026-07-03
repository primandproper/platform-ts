import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type { EventContext, EventProperties, EventReporter } from "../analytics.js";

const o11yName = "analytics";

/**
 * The raw, may-throw operations a vendor SDK adapter exposes. Each vendor's `provide*` factory
 * builds one of these over its SDK client (Node or browser); {@link VendorReporter} wraps it with
 * the best-effort, never-throw contract every provider shares. Keeping this boundary universal lets
 * the reporter logic stay in one place while the SDK imports live only in the `*.node.ts` /
 * `*.browser.ts` factories.
 */
export interface VendorSink {
  track(event: string, properties: EventProperties | undefined, context: EventContext | undefined): void;
  identify(userId: string, traits: EventProperties | undefined): void;
  page(name: string, properties: EventProperties | undefined, context: EventContext | undefined): void;
  screen(name: string, properties: EventProperties | undefined, context: EventContext | undefined): void;
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

  constructor(provider: string, sink: VendorSink, deps: ObservabilityDeps = {}) {
    this.#sink = sink;
    this.#provider = provider;
    const observer: Observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = observer.logger();
  }

  track(event: string, properties?: EventProperties, context?: EventContext): void {
    try {
      this.#sink.track(event, properties, context);
    } catch (err) {
      this.#log("track", err, { event });
    }
  }

  identify(userId: string, traits?: EventProperties): void {
    try {
      this.#sink.identify(userId, traits);
    } catch (err) {
      this.#log("identify", err, { userId });
    }
  }

  page(name: string, properties?: EventProperties, context?: EventContext): void {
    try {
      this.#sink.page(name, properties, context);
    } catch (err) {
      this.#log("page", err, { name });
    }
  }

  screen(name: string, properties?: EventProperties, context?: EventContext): void {
    try {
      this.#sink.screen(name, properties, context);
    } catch (err) {
      this.#log("screen", err, { name });
    }
  }

  async flush(): Promise<void> {
    try {
      await this.#sink.flush();
    } catch (err) {
      this.#log("flush", err);
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.#sink.shutdown();
    } catch (err) {
      this.#log("shutdown", err);
    }
  }

  #log(operation: string, err: unknown, values?: EventProperties): void {
    this.#logger
      .with({ provider: this.#provider, operation, ...values })
      .error(`analytics ${operation} failed`, err);
  }
}
