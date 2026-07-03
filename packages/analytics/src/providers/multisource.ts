import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type { EventContext, EventProperties, EventReporter } from "../analytics.js";

import { NoopReporter } from "./noop.js";

const o11yName = "analytics";

/**
 * The event property that records which source an event came from (e.g. `ios`, `web`). When several
 * sources share one backing account (a single PostHog project key across sources, say), this is how
 * downstream tooling disambiguates them. Mirrors the Go platform's `SourcePropertyKey`.
 */
export const SOURCE_PROPERTY_KEY = "source";

/**
 * Routes analytics calls to a per-source {@link EventReporter}. Unlike a broadcast reporter it
 * delegates to exactly one reporter — the one registered for the leading `source` argument — and
 * stamps the source onto every event's properties. An unknown source degrades to a noop (logged),
 * never an error, so a misrouted call can't take down the caller. Ports Go's
 * `MultiSourceEventReporter`; the `ios`/`web` source set is left to the caller rather than codified.
 *
 * This is intentionally *not* an {@link EventReporter} — its methods take a leading `source`.
 */
export class MultiSourceReporter {
  readonly #reporters: Record<string, EventReporter>;
  readonly #logger: Logger;

  constructor(reporters: Record<string, EventReporter>, deps: ObservabilityDeps = {}) {
    this.#reporters = reporters;
    const observer: Observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = observer.logger();
  }

  track(source: string, event: string, properties?: EventProperties, context?: EventContext): void {
    this.#reporterFor(source).track(event, this.#withSource(source, properties), context);
  }

  identify(source: string, userId: string, traits?: EventProperties): void {
    this.#reporterFor(source).identify(userId, this.#withSource(source, traits));
  }

  page(source: string, name: string, properties?: EventProperties, context?: EventContext): void {
    this.#reporterFor(source).page?.(name, this.#withSource(source, properties), context);
  }

  screen(source: string, name: string, properties?: EventProperties, context?: EventContext): void {
    this.#reporterFor(source).screen?.(name, this.#withSource(source, properties), context);
  }

  /** Flushes every registered source reporter. Best-effort; never throws. */
  async flush(): Promise<void> {
    await Promise.all(Object.values(this.#reporters).map((r) => r.flush()));
  }

  /** Flushes and releases every registered source reporter. Best-effort; never throws. */
  async shutdown(): Promise<void> {
    await Promise.all(Object.values(this.#reporters).map((r) => r.shutdown()));
  }

  /** Returns the reporter for `source`, falling back to a noop (logged) for an unknown source. */
  #reporterFor(source: string): EventReporter {
    const reporter = this.#reporters[source];
    if (reporter) {
      return reporter;
    }
    this.#logger
      .with({ source, knownSources: Object.keys(this.#reporters) })
      .warn("no analytics reporter configured for source, using noop");
    return new NoopReporter();
  }

  #withSource(source: string, properties: EventProperties | undefined): EventProperties {
    return { ...properties, [SOURCE_PROPERTY_KEY]: source };
  }
}
