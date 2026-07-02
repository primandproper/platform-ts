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
  #state: StreamState = "closed";

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
    this.closeTransport();
    for (const handler of this.#closeHandlers) {
      handler();
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
    for (const handler of this.#openHandlers) {
      handler();
    }
  }

  /** Fans a delivered message out to the catch-all and matching per-event handlers. */
  protected dispatchMessage(message: StreamMessage): void {
    for (const handler of this.#messageHandlers) {
      handler(message);
    }
    if (message.event !== undefined) {
      const handlers = this.#eventHandlers.get(message.event);
      if (handlers !== undefined) {
        for (const handler of handlers) {
          handler(message);
        }
      }
    }
  }

  /** Fans a transport error out to {@link onError} handlers. */
  protected dispatchError(err: unknown): void {
    for (const handler of this.#errorHandlers) {
      handler(err);
    }
  }
}
