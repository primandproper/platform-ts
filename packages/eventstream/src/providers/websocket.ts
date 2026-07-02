import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type { StreamMessage } from "../eventstream.js";

import { EventStreamEmitter } from "./emitter.js";
import {
  globalCtor,
  type WebSocketCloseEvent,
  type WebSocketCtor,
  type WebSocketLike,
  type WebSocketMessage,
} from "./transports.js";

const o11yName = "eventstream";

export interface WebSocketEventStreamOptions {
  /** The WebSocket endpoint URL (`ws://` or `wss://`). */
  url: string;
  /** Optional subprotocol(s) passed through to the `WebSocket` constructor. */
  protocols?: string | string[];
  /**
   * The `WebSocket` constructor to use. Defaults to `globalThis.WebSocket`. Inject one (e.g.
   * from the `ws` package) on Node < 22, or a fake in tests.
   */
  webSocketCtor?: WebSocketCtor;
  /**
   * Parses an inbound frame into a {@link StreamMessage}. Defaults to treating each text
   * frame as a JSON object of the form `{ event?, data, id? }`, falling back to the raw text
   * as `data` when it isn't such an object. Override to match a different wire format.
   */
  parse?: (raw: string) => StreamMessage;
}

/**
 * WebSocket transport over `WebSocket`. Universal: the constructor is injected, defaulting to
 * `globalThis.WebSocket`. The browser and Node provider entries differ only in that default.
 * Only text frames are delivered; binary frames are surfaced as an error.
 */
export class WebSocketEventStream extends EventStreamEmitter {
  readonly #url: string;
  readonly #protocols: string | string[] | undefined;
  readonly #ctor: WebSocketCtor;
  readonly #parse: (raw: string) => StreamMessage;
  readonly #observer: Observer;
  readonly #logger: Logger;
  #socket: WebSocketLike | undefined;

  constructor(options: WebSocketEventStreamOptions, deps: ObservabilityDeps = {}) {
    super();
    const ctor =
      options.webSocketCtor ?? (globalCtor("WebSocket") as WebSocketCtor | undefined);
    if (ctor === undefined) {
      throw new Error(
        "no WebSocket available; inject one via options.webSocketCtor (e.g. from the 'ws' " +
          "package) on Node < 22",
      );
    }
    this.#url = options.url;
    this.#protocols = options.protocols;
    this.#ctor = ctor;
    this.#parse = options.parse ?? defaultParse;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  /** Sends a text frame. Throws if the connection is not open. */
  send(data: string): void {
    if (this.#socket === undefined || this.state !== "open") {
      throw new Error("cannot send on a WebSocket that is not open");
    }
    this.#socket.send(data);
  }

  protected openTransport(): void {
    this.#logger.debug("opening WebSocket connection");
    const socket =
      this.#protocols === undefined
        ? new this.#ctor(this.#url)
        : new this.#ctor(this.#url, this.#protocols);
    this.#socket = socket;

    socket.onopen = () => {
      this.dispatchOpen();
    };
    socket.onmessage = (ev: WebSocketMessage) => {
      if (typeof ev.data !== "string") {
        this.dispatchError(new Error("received a non-text WebSocket frame"));
        return;
      }
      this.dispatchMessage(this.#parse(ev.data));
    };
    socket.onerror = (ev: unknown) => {
      this.#logger.error("WebSocket connection error", ev);
      this.dispatchError(ev);
    };
    socket.onclose = (ev: WebSocketCloseEvent) => {
      this.#logger
        .with({ code: ev.code, reason: ev.reason })
        .debug("WebSocket closed by peer");
      this.close();
    };
  }

  protected closeTransport(): void {
    if (this.#socket === undefined) {
      return;
    }
    this.#socket.onopen = null;
    this.#socket.onmessage = null;
    this.#socket.onerror = null;
    this.#socket.onclose = null;
    this.#socket.close();
    this.#socket = undefined;
    this.#logger.debug("closed WebSocket connection");
  }
}

/** Default frame parser: a JSON `{ event?, data, id? }` object, else the raw text as `data`. */
function defaultParse(raw: string): StreamMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { data: raw };
  }
  if (typeof parsed === "object" && parsed !== null && "data" in parsed) {
    const obj = parsed as Record<string, unknown>;
    const message: StreamMessage = {
      data: typeof obj.data === "string" ? obj.data : raw,
    };
    if (typeof obj.event === "string") {
      message.event = obj.event;
    }
    if (typeof obj.id === "string") {
      message.id = obj.id;
    }
    return message;
  }
  return { data: raw };
}
