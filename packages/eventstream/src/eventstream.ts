/**
 * The universal event-stream contract. An {@link EventStream} is a small, event-emitter-like
 * abstraction over a one-way (SSE) or two-way (WebSocket) server connection: you register
 * handlers, `connect()`, consume messages, and `close()`. The same interface is implemented
 * by the SSE and WebSocket transports, so call-site code is transport-agnostic.
 */

/** A single delivered event. Mirrors the SSE field shape; `data` is always a string. */
export interface StreamMessage {
  /** The named event type (SSE `event:` field, or a WebSocket logical channel). */
  event?: string;
  /** The payload. SSE delivers strings; binary WebSocket frames are not supported. */
  data: string;
  /** The optional event id (SSE `id:` field). */
  id?: string;
}

/** Receives a delivered {@link StreamMessage}. */
export type MessageHandler = (message: StreamMessage) => void;

/** Receives the transport-level error that surfaced on the connection. */
export type ErrorHandler = (err: unknown) => void;

/** Invoked with no arguments on open/close lifecycle transitions. */
export type LifecycleHandler = () => void;

/** Unregisters a previously registered handler. Idempotent. */
export type Unsubscribe = () => void;

/** The connection lifecycle state. */
export type StreamState = "connecting" | "open" | "closed";

/**
 * A swappable, event-emitter-like stream. Registration methods return an {@link Unsubscribe}
 * so callers can detach without exposing the underlying socket. Handlers registered before
 * {@link EventStream.connect} are honored once the connection opens.
 */
export interface EventStream {
  /** The current lifecycle state. Starts `closed` and is never reset after {@link close}. */
  readonly state: StreamState;

  /** Opens the underlying connection. Calling it while already open or connecting is a noop. */
  connect(): void;

  /** Registers a handler for every message, regardless of event type. */
  onMessage(handler: MessageHandler): Unsubscribe;

  /** Registers a handler for messages whose `event` matches the given name. */
  on(event: string, handler: MessageHandler): Unsubscribe;

  /** Registers a handler invoked when the connection opens. */
  onOpen(handler: LifecycleHandler): Unsubscribe;

  /** Registers a handler invoked when the transport reports an error. */
  onError(handler: ErrorHandler): Unsubscribe;

  /** Registers a handler invoked when the connection closes. */
  onClose(handler: LifecycleHandler): Unsubscribe;

  /** Tears down the connection, detaches transport listeners, and sets `state` to `closed`. */
  close(): void;
}
