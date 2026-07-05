import { noopLogger, type Logger } from "@primandproper/observability";

import type {
  ErrorHandler,
  EventStream,
  LifecycleHandler,
  MessageHandler,
  StreamMessage,
  StreamState,
  Unsubscribe,
} from "../eventstream.js";

/**
 * Shared registration/dispatch bookkeeping for the SSE and WebSocket transports. Subclasses
 * implement {@link openTransport} and {@link closeTransport}; this base owns the handler
 * sets, the lifecycle state machine, and the dispatch helpers. It is universal — no Node
 * built-ins, no DOM globals — so it ships in both the node and browser bundles.
 */
export abstract class EventStreamEmitter implements EventStream {
  readonly #messageHandlers = new Set<MessageHandler>();
  readonly #eventHandlers = new Map<string, Set<MessageHandler>>();
  readonly #openHandlers = new Set<LifecycleHandler>();
  readonly #errorHandlers = new Set<ErrorHandler>();
  readonly #closeHandlers = new Set<LifecycleHandler>();
  readonly #heartbeatTimeoutMs: number;
  readonly #logger: Logger;
  #heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  #state: StreamState = "closed";

  /**
   * @param heartbeatTimeoutMs When > 0, a liveness deadline: the connection is declared dead if no
   *   message arrives within this window (a half-open TCP otherwise reads "open" forever). The
   *   timer arms on open and resets on every message; on expiry {@link onHeartbeatTimeout} fires.
   *   `0` (the default) disables it — appropriate when the stream is legitimately idle for long
   *   stretches and no server heartbeat bounds the gap.
   * @param logger Used to record a subscriber throw; defaults to the noop logger.
   */
  constructor(heartbeatTimeoutMs = 0, logger: Logger = noopLogger) {
    this.#heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.#logger = logger;
  }

  get state(): StreamState {
    return this.#state;
  }

  connect(): void {
    if (this.#state !== "closed") {
      return;
    }
    this.#state = "connecting";
    this.openTransport();
  }

  onMessage(handler: MessageHandler): Unsubscribe {
    this.#messageHandlers.add(handler);
    return () => {
      this.#messageHandlers.delete(handler);
    };
  }

  on(event: string, handler: MessageHandler): Unsubscribe {
    let handlers = this.#eventHandlers.get(event);
    if (handlers === undefined) {
      handlers = new Set();
      this.#eventHandlers.set(event, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.#eventHandlers.delete(event);
      }
    };
  }

  onOpen(handler: LifecycleHandler): Unsubscribe {
    this.#openHandlers.add(handler);
    return () => {
      this.#openHandlers.delete(handler);
    };
  }

  onError(handler: ErrorHandler): Unsubscribe {
    this.#errorHandlers.add(handler);
    return () => {
      this.#errorHandlers.delete(handler);
    };
  }

  onClose(handler: LifecycleHandler): Unsubscribe {
    this.#closeHandlers.add(handler);
    return () => {
      this.#closeHandlers.delete(handler);
    };
  }

  close(): void {
    if (this.#state === "closed") {
      return;
    }
    this.#state = "closed";
    this.#clearHeartbeat();
    this.closeTransport();
    for (const handler of this.#closeHandlers) {
      this.#safe(handler);
    }
  }

  /**
   * Invokes a subscriber, isolating its throw so one bad handler can't break dispatch for the
   * others, and logging the throw rather than letting it escape.
   */
  #safe(handler: () => void): void {
    try {
      handler();
    } catch (err) {
      this.#logger.error("event stream subscriber threw", err);
    }
  }

  /** Opens the underlying transport. Implementations call {@link dispatchOpen} once ready. */
  protected abstract openTransport(): void;

  /** Detaches listeners and closes the underlying transport. Must be idempotent. */
  protected abstract closeTransport(): void;

  /** Marks the stream open and fans out to {@link onOpen} handlers. */
  protected dispatchOpen(): void {
    if (this.#state === "closed") {
      return;
    }
    this.#state = "open";
    this.#armHeartbeat();
    for (const handler of this.#openHandlers) {
      this.#safe(handler);
    }
  }

  /** Fans a delivered message out to the catch-all and matching per-event handlers. */
  protected dispatchMessage(message: StreamMessage): void {
    this.#armHeartbeat(); // any inbound message is proof of life; reset the liveness deadline
    for (const handler of this.#messageHandlers) {
      this.#safe(() => {
        handler(message);
      });
    }
    if (message.event !== undefined) {
      const handlers = this.#eventHandlers.get(message.event);
      if (handlers !== undefined) {
        for (const handler of handlers) {
          this.#safe(() => {
            handler(message);
          });
        }
      }
    }
  }

  /**
   * Reflects the transport dropping and re-establishing: `open` → `connecting`. A no-op once
   * `closed`, so a reconnect signal can never resurrect a deliberately closed stream.
   */
  protected dispatchReconnecting(): void {
    if (this.#state === "open") {
      this.#state = "connecting";
    }
    this.#clearHeartbeat(); // re-armed when the next open lands
  }

  /** Arms/resets the liveness deadline. No-op when heartbeats are disabled. */
  #armHeartbeat(): void {
    if (this.#heartbeatTimeoutMs <= 0) {
      return;
    }
    this.#clearHeartbeat();
    this.#heartbeatTimer = setTimeout(() => {
      this.#heartbeatTimer = undefined;
      this.onHeartbeatTimeout();
    }, this.#heartbeatTimeoutMs);
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer !== undefined) {
      clearTimeout(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
  }

  /**
   * Called when the liveness deadline lapses with no inbound message. Subclasses react by tearing
   * the (presumed half-open) connection down and reconnecting. No-op by default.
   */
  protected onHeartbeatTimeout(): void {
    // Overridden by transports that carry a logger and reconnect machinery.
  }

  /** Fans a transport error out to {@link onError} handlers. */
  protected dispatchError(err: unknown): void {
    for (const handler of this.#errorHandlers) {
      this.#safe(() => {
        handler(err);
      });
    }
  }
}
