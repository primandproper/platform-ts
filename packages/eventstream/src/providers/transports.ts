/**
 * The minimal slices of the `EventSource` and `WebSocket` surfaces the transports actually
 * use. They're intentionally structural and small so (a) a hand-written fake satisfies them
 * with little ceremony, and (b) the real DOM/global `EventSource`/`WebSocket` are assignable
 * to them — which is what lets the constructor be injected for runtime portability without a
 * hard dependency. See {@link EventSourceCtor} and {@link WebSocketCtor}.
 */

/** A message event as delivered by `EventSource`. Only the fields we read are required. */
export interface EventSourceMessage {
  data: string;
  lastEventId?: string;
}

/** The injectable `EventSource` instance surface used by the SSE transport. */
export interface EventSourceLike {
  onopen: ((this: EventSourceLike, ev: unknown) => void) | null;
  onmessage: ((this: EventSourceLike, ev: EventSourceMessage) => void) | null;
  onerror: ((this: EventSourceLike, ev: unknown) => void) | null;
  /**
   * The connection state per the `EventSource` spec: `0` CONNECTING, `1` OPEN, `2` CLOSED. Read
   * inside `onerror` to tell a transient reconnect (CONNECTING) from a fatal give-up (CLOSED),
   * since `EventSource` multiplexes both through the same error event.
   */
  readonly readyState: number;
  addEventListener(type: string, listener: (ev: EventSourceMessage) => void): void;
  removeEventListener(type: string, listener: (ev: EventSourceMessage) => void): void;
  close(): void;
}

/** `EventSource.readyState` values (the spec's named constants). */
export const EVENT_SOURCE_CONNECTING = 0;
export const EVENT_SOURCE_CLOSED = 2;

/**
 * An injectable `EventSource` constructor. The browser/Node globals are assignable to this,
 * as are `undici`'s and the `eventsource` package's implementations — inject one of those on
 * Node < 22 where the global `EventSource` is not yet stable.
 */
export type EventSourceCtor = new (url: string) => EventSourceLike;

/** A message event as delivered by `WebSocket`. Only the fields we read are required. */
export interface WebSocketMessage {
  data: unknown;
}

/** A close event as delivered by `WebSocket`. */
export interface WebSocketCloseEvent {
  code?: number;
  reason?: string;
}

/** The injectable `WebSocket` instance surface used by the WebSocket transport. */
export interface WebSocketLike {
  onopen: ((this: WebSocketLike, ev: unknown) => void) | null;
  onmessage: ((this: WebSocketLike, ev: WebSocketMessage) => void) | null;
  onerror: ((this: WebSocketLike, ev: unknown) => void) | null;
  onclose: ((this: WebSocketLike, ev: WebSocketCloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/**
 * An injectable `WebSocket` constructor. The browser/Node globals are assignable to this, as
 * is the `ws` package — inject one on Node < 22 where the global `WebSocket` is not stable.
 */
export type WebSocketCtor = new (
  url: string,
  protocols?: string | string[],
) => WebSocketLike;

/**
 * Reads a constructor off `globalThis` by name, returning `undefined` when it is absent. Used
 * to resolve the default `EventSource`/`WebSocket` without assuming the DOM lib types are
 * present at runtime — on older Node the global genuinely may not exist.
 */
export function globalCtor(name: string): unknown {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === "function" ? value : undefined;
}
