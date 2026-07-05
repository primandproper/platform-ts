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

/**
 * Auto-reconnect tuning. Omit for the defaults (enabled, 500ms base, 30s cap, 50% jitter); pass
 * `false` to disable so a drop ends the stream. Delays follow exponential backoff with jitter,
 * mirroring `@primandproper/retry`'s formula (that package exposes only a `run()`-oriented Policy,
 * not a standalone jitter, so a supervised reconnect loop can't reuse it directly).
 */
export interface ReconnectOptions {
  /** First backoff delay, doubled each consecutive attempt. Default 500ms. */
  baseDelayMs?: number;
  /** Upper bound on the backoff delay. Default 30_000ms. */
  maxDelayMs?: number;
  /** Fraction of the delay to randomize away, in `[0, 1]`. Default 0.5. */
  jitter?: number;
  /** Randomness source for jitter; injectable for deterministic tests. Default `Math.random`. */
  random?: () => number;
}

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
  /** Auto-reconnect behavior on an unclean drop. Default on; pass `false` to disable. */
  reconnect?: ReconnectOptions | false;
  /**
   * Liveness deadline in ms: if no frame arrives within this window the connection is assumed
   * half-open, torn down, and reconnected (subject to {@link reconnect}). `0`/omitted disables it.
   */
  heartbeatTimeoutMs?: number;
}

// Close codes that signal a deliberate shutdown — no reconnect. Everything else (notably 1006
// abnormal closure) is treated as a transient drop worth retrying.
function isCleanClose(code: number | undefined): boolean {
  return code === undefined || code === 1000 || code === 1001;
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
  readonly #reconnect: boolean;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #jitter: number;
  readonly #random: () => number;
  #socket: WebSocketLike | undefined;
  #reconnectAttempts = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: WebSocketEventStreamOptions, deps: ObservabilityDeps = {}) {
    // super() must be the first statement (field initializers below), so derive the logger inline.
    super(
      options.heartbeatTimeoutMs ?? 0,
      (deps.observer ?? makeObserver(o11yName, deps)).logger(),
    );
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

    this.#reconnect = options.reconnect !== false;
    const rc: ReconnectOptions =
      options.reconnect === false || options.reconnect === undefined
        ? {}
        : options.reconnect;
    this.#baseDelayMs = rc.baseDelayMs ?? 500;
    this.#maxDelayMs = rc.maxDelayMs ?? 30_000;
    this.#jitter = rc.jitter ?? 0.5;
    this.#random = rc.random ?? Math.random;
  }

  protected override onHeartbeatTimeout(): void {
    this.#logger.warn("WebSocket heartbeat timeout; connection assumed half-open");
    this.dispatchError(new Error("WebSocket heartbeat timeout"));
    if (!this.#reconnect) {
      this.close();
      return;
    }
    this.#detachSocket();
    this.dispatchReconnecting();
    this.#scheduleReconnect();
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
      this.#reconnectAttempts = 0; // a fresh connection resets the backoff
      this.#logger.info("WebSocket connection open");
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
      // A clean shutdown (or reconnect disabled) ends the stream; a transient drop schedules a
      // backoff reconnect instead of silently ending at debug level.
      if (!this.#reconnect || isCleanClose(ev.code)) {
        this.close();
        return;
      }
      this.#detachSocket();
      this.dispatchReconnecting();
      this.#scheduleReconnect();
    };
  }

  protected closeTransport(): void {
    // Called by the base `close()` (state is already "closed"): cancel any pending reconnect so a
    // user-initiated close is final, then tear down the live socket.
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    this.#detachSocket();
    this.#logger.debug("closed WebSocket connection");
  }

  /** Detaches handlers and closes the current socket without touching lifecycle state. */
  #detachSocket(): void {
    if (this.#socket === undefined) {
      return;
    }
    this.#socket.onopen = null;
    this.#socket.onmessage = null;
    this.#socket.onerror = null;
    this.#socket.onclose = null;
    this.#socket.close();
    this.#socket = undefined;
  }

  #scheduleReconnect(): void {
    const delay = this.#backoffDelay(this.#reconnectAttempts);
    this.#reconnectAttempts += 1;
    this.#logger.debug(`reconnecting WebSocket in ${String(delay)}ms`);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      // A user `close()` between scheduling and firing wins — never resurrect a closed stream.
      if (this.state === "closed") {
        return;
      }
      this.openTransport();
    }, delay);
  }

  // Exponential backoff with jitter, mirroring @primandproper/retry's delay formula.
  #backoffDelay(attempt: number): number {
    const capped = Math.min(this.#baseDelayMs * 2 ** attempt, this.#maxDelayMs);
    const span = capped * this.#jitter;
    return Math.round(capped - span + this.#random() * span);
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
