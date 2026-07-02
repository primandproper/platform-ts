import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import { parseNotification } from "../notification-parse.js";
import type {
  NotificationClient,
  NotificationClientState,
  NotificationHandler,
  Unsubscribe,
} from "../notifications.js";

import { SubscriptionRegistry } from "./registry.js";

const o11yName = "notifications";

/**
 * The minimal structural surface this provider needs from a `WebSocket`. Kept intentionally
 * narrow so the provider stays universal and the socket is trivially fakeable in tests — the
 * standard `WebSocket` (browser / Node 22+) satisfies it.
 */
export interface WebSocketLike {
  addEventListener(type: "open" | "close", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  close(): void;
}

/** Constructs a {@link WebSocketLike} for a URL — the injection seam for tests/older Node. */
export type WebSocketConstructor = (url: string) => WebSocketLike;

export interface WebSocketNotificationOptions {
  /** The endpoint to connect to. */
  url: string;
  /**
   * Factory for the underlying socket. Defaults to wrapping `globalThis.WebSocket`, which
   * exists in modern browsers and Node 22+. On older Node, inject one explicitly, e.g.
   * `{ webSocketFactory: (url) => new (require("ws"))(url) }`.
   */
  webSocketFactory?: WebSocketConstructor;
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  const ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike })
    .WebSocket;
  if (ctor === undefined) {
    throw new Error(
      "globalThis.WebSocket is unavailable; inject `webSocketFactory` (Node < 22 or a polyfill)",
    );
  }
  return new ctor(url);
}

/**
 * Universal provider backed by an injectable `WebSocket`. Inbound frames are parsed as JSON
 * {@link Notification} envelopes and routed to channel subscribers; malformed frames are
 * logged and dropped. This is the real default provider.
 */
export class WebSocketNotificationClient implements NotificationClient {
  readonly #url: string;
  readonly #factory: WebSocketConstructor;
  readonly #registry: SubscriptionRegistry;
  readonly #observer: Observer;
  readonly #logger: Logger;

  #socket: WebSocketLike | undefined;
  #state: NotificationClientState = "idle";

  constructor(options: WebSocketNotificationOptions, deps: ObservabilityDeps = {}) {
    this.#url = options.url;
    this.#factory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.#registry = new SubscriptionRegistry(deps);
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  get state(): NotificationClientState {
    return this.#state;
  }

  subscribe(channel: string, handler: NotificationHandler): Unsubscribe {
    return this.#registry.subscribe(channel, handler);
  }

  onNotification(handler: NotificationHandler): Unsubscribe {
    return this.#registry.onNotification(handler);
  }

  connect(): void {
    if (this.#state === "connecting" || this.#state === "open") {
      return;
    }
    this.#state = "connecting";
    const socket = this.#factory(this.#url);
    this.#socket = socket;

    socket.addEventListener("open", () => {
      this.#state = "open";
      this.#logger.debug("notification socket open");
    });
    socket.addEventListener("close", () => {
      this.#state = "closed";
      this.#socket = undefined;
      this.#logger.debug("notification socket closed");
    });
    socket.addEventListener("message", (event) => {
      this.#handleFrame(event.data);
    });
  }

  close(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    this.#state = "closed";
    if (socket !== undefined) {
      socket.close();
    }
  }

  #handleFrame(data: unknown): void {
    const notification = parseNotification(data);
    if (notification === undefined) {
      this.#logger.warn("dropping malformed notification frame");
      return;
    }
    this.#registry.dispatch(notification);
  }
}
