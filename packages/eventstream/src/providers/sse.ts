import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import { EventStreamEmitter } from "./emitter.js";
import {
  EVENT_SOURCE_CLOSED,
  EVENT_SOURCE_CONNECTING,
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
  /**
   * Liveness deadline in ms: if no event arrives within this window the connection is assumed
   * half-open and reopened with a fresh `EventSource`. `0`/omitted disables it.
   */
  heartbeatTimeoutMs?: number;
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
  // Named-event listeners registered on the current source, retained so they can be removed when
  // the source is torn down (a reconnect creates a fresh source, so leaving them attached leaks).
  #namedListeners: { type: string; listener: (ev: EventSourceMessage) => void }[] = [];

  constructor(options: SseEventStreamOptions, deps: ObservabilityDeps = {}) {
    // super() must be the first statement (field initializers below), so derive the logger inline.
    super(
      options.heartbeatTimeoutMs ?? 0,
      (deps.observer ?? makeObserver(o11yName, deps)).logger(),
    );
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

  protected override onHeartbeatTimeout(): void {
    this.#logger.warn("SSE heartbeat timeout; reopening connection");
    this.dispatchError(new Error("SSE heartbeat timeout"));
    // A half-open EventSource won't fire onerror on its own, so force a fresh connection.
    this.#detachSource();
    this.dispatchReconnecting();
    this.openTransport();
  }

  protected openTransport(): void {
    this.#logger.debug("opening SSE connection");
    const source = new this.#ctor(this.#url);
    this.#source = source;

    source.onopen = () => {
      this.#logger.info("SSE connection open");
      this.dispatchOpen();
    };
    source.onmessage = (ev: EventSourceMessage) => {
      this.dispatchMessage({ data: ev.data, ...idOf(ev) });
    };
    source.onerror = (ev: unknown) => {
      this.#logger.error("SSE connection error", ev);
      this.dispatchError(ev);
      // EventSource multiplexes transient reconnects and fatal give-ups through one error event;
      // consult readyState so `state` and `onClose` stop lying. CLOSED = it gave up (fire close);
      // CONNECTING = it dropped and is retrying (reflect as connecting, not still-open).
      if (source.readyState === EVENT_SOURCE_CLOSED) {
        this.#logger.warn("SSE closed after fatal error");
        this.close();
      } else if (source.readyState === EVENT_SOURCE_CONNECTING) {
        this.#logger.debug("SSE dropped; reconnecting");
        this.dispatchReconnecting();
      }
    };
    for (const event of this.#events) {
      const listener = (ev: EventSourceMessage): void => {
        this.dispatchMessage({ event, data: ev.data, ...idOf(ev) });
      };
      source.addEventListener(event, listener);
      this.#namedListeners.push({ type: event, listener });
    }
  }

  protected closeTransport(): void {
    this.#detachSource();
    this.#logger.debug("closed SSE connection");
  }

  /** Detaches handlers and closes the current source without touching lifecycle state. */
  #detachSource(): void {
    if (this.#source === undefined) {
      return;
    }
    this.#source.onopen = null;
    this.#source.onmessage = null;
    this.#source.onerror = null;
    // Remove the named-event listeners we attached so a torn-down source leaves nothing behind.
    for (const { type, listener } of this.#namedListeners) {
      this.#source.removeEventListener(type, listener);
    }
    this.#namedListeners = [];
    this.#source.close();
    this.#source = undefined;
  }
}

/** Lifts the optional `lastEventId` into the `{ id }` shape, omitting it when empty. */
function idOf(ev: EventSourceMessage): { id?: string } {
  return ev.lastEventId !== undefined && ev.lastEventId !== ""
    ? { id: ev.lastEventId }
    : {};
}
