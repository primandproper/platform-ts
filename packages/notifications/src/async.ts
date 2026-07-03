/**
 * The async-notification contract, ported from platform-go's `notifications/async`. An
 * {@link AsyncNotifier} *publishes* events to named channels; delivery to end clients is the
 * backend's job (Pusher, Ably, or — in Go — server-managed WebSocket/SSE connections).
 */

/** An async notification event published to a channel. Go's `async.Event`. */
export interface AsyncEvent {
  /** Application-defined discriminator for the payload. */
  type: string;
  /** Optional opaque payload; providers forward it verbatim to the backend. */
  data?: unknown;
}

/**
 * Publishes events to named channels. Implementations may deliver via Pusher, Ably, or other
 * backends. Faithful to Go's `async.AsyncNotifier`.
 */
export interface AsyncNotifier {
  /** Sends an event to all subscribers of the given channel. */
  publish(channel: string, event: AsyncEvent): Promise<void>;
  /** Releases resources held by the notifier. */
  close(): void;
}

/**
 * Optional interface for backends that manage server-side client connections (WebSocket, SSE).
 * Faithful to Go's `async.ConnectionAcceptor`, kept for interface parity.
 *
 * No provider in this package implements it: accepting an inbound connection requires upgrading
 * a live HTTP request, which is owned by the server framework (Fastify/Hono/`ws`) — the same
 * reason `routing`/`server` are out of scope for platform-ts. A WebSocket/SSE notifier would
 * plug a framework's upgrade handle into this seam.
 */
export interface ConnectionAcceptor {
  /**
   * Upgrades an inbound request to a persistent connection registered under `channel` and
   * `memberID`. `request`/`response` are intentionally `unknown` — the concrete types belong to
   * whichever HTTP framework owns the connection.
   */
  acceptConnection(
    request: unknown,
    response: unknown,
    channel: string,
    memberID: string,
  ): Promise<void>;
}

/** Returned when a provider is constructed without its required config. Go's `ErrNilConfig`. */
export const ErrNilConfig = new Error("async notifier config is nil");
