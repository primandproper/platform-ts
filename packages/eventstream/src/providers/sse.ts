import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import { EventStreamEmitter } from "./emitter.js";
import {
  globalCtor,
  type EventSourceCtor,
  type EventSourceLike,
  type EventSourceMessage,
} from "./transports.js";

const o11yName = "eventstream";

export interface SseEventStreamOptions {
  /** The SSE endpoint URL. */
  url: string;
  /**
   * Named events (SSE `event:` field) to subscribe to in addition to the default `message`
   * stream. `EventSource` only delivers named events to per-type listeners, so they must be
   * declared up front for {@link EventStream.on} to receive them.
   */
  events?: readonly string[];
  /**
   * The `EventSource` constructor to use. Defaults to `globalThis.EventSource`. Inject one
   * (e.g. from `undici` or the `eventsource` package) on Node < 22, or a fake in tests.
   */
  eventSourceCtor?: EventSourceCtor;
}

/**
 * SSE transport over `EventSource`. Universal: it touches no Node built-in and no DOM global
 * directly — the constructor is injected, defaulting to `globalThis.EventSource`. The
 * browser and Node provider entries differ only in that default.
 */
export class SseEventStream extends EventStreamEmitter {
  readonly #url: string;
  readonly #events: readonly string[];
  readonly #ctor: EventSourceCtor;
  readonly #observer: Observer;
  readonly #logger: Logger;
  #source: EventSourceLike | undefined;

  constructor(options: SseEventStreamOptions, deps: ObservabilityDeps = {}) {
    super();
    const ctor =
      options.eventSourceCtor ??
      (globalCtor("EventSource") as EventSourceCtor | undefined);
    if (ctor === undefined) {
      throw new Error(
        "no EventSource available; inject one via options.eventSourceCtor (e.g. from " +
          "'undici' or the 'eventsource' package) on Node < 22",
      );
    }
    this.#url = options.url;
    this.#events = options.events ?? [];
    this.#ctor = ctor;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  protected openTransport(): void {
    this.#logger.debug("opening SSE connection");
    const source = new this.#ctor(this.#url);
    this.#source = source;

    source.onopen = () => {
      this.dispatchOpen();
    };
    source.onmessage = (ev: EventSourceMessage) => {
      this.dispatchMessage({ data: ev.data, ...idOf(ev) });
    };
    source.onerror = (ev: unknown) => {
      this.#logger.error("SSE connection error", ev);
      this.dispatchError(ev);
    };
    for (const event of this.#events) {
      source.addEventListener(event, (ev: EventSourceMessage) => {
        this.dispatchMessage({ event, data: ev.data, ...idOf(ev) });
      });
    }
  }

  protected closeTransport(): void {
    if (this.#source === undefined) {
      return;
    }
    this.#source.onopen = null;
    this.#source.onmessage = null;
    this.#source.onerror = null;
    this.#source.close();
    this.#source = undefined;
    this.#logger.debug("closed SSE connection");
  }
}

/** Lifts the optional `lastEventId` into the `{ id }` shape, omitting it when empty. */
function idOf(ev: EventSourceMessage): { id?: string } {
  return ev.lastEventId !== undefined && ev.lastEventId !== ""
    ? { id: ev.lastEventId }
    : {};
}
