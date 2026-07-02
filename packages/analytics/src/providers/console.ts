import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type { EventContext, EventProperties, EventReporter } from "../analytics.js";

const o11yName = "analytics";

/**
 * Universal reporter that logs each call via the injected {@link Logger}. Useful in local
 * development and as a fallback when no real analytics backend is wired up. With no logger
 * supplied it degrades to the noop logger, so it never throws.
 */
export class ConsoleReporter implements EventReporter {
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(deps: ObservabilityDeps = {}) {
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  track(event: string, properties?: EventProperties, context?: EventContext): void {
    this.#logger.with({ event, properties, context }).info("analytics track");
  }

  identify(userId: string, traits?: EventProperties): void {
    this.#logger.with({ userId, traits }).info("analytics identify");
  }

  page(name: string, properties?: EventProperties, context?: EventContext): void {
    this.#logger.with({ name, properties, context }).info("analytics page");
  }

  screen(name: string, properties?: EventProperties, context?: EventContext): void {
    this.#logger.with({ name, properties, context }).info("analytics screen");
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
