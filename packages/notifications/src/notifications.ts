/**
 * The universal notifications contract. The browser is the subscriber (client); the same
 * interface is usable in Node test/SSR contexts. Delivery is asynchronous and provider-driven
 * (WebSocket, an in-memory bus, or a noop), so call-site code is identical across providers.
 */

/**
 * A typed delivery envelope. `payload` is intentionally `unknown` — providers don't know its
 * shape, so callers narrow it at the subscription site.
 */
export interface Notification {
  /** Unique id for this notification, for de-duplication/acknowledgement. */
  id: string;
  /** The logical channel the notification was published to. */
  channel: string;
  /** Application-defined discriminator for the payload. */
  type: string;
  payload: unknown;
  /** Epoch milliseconds the server sent it, when known. */
  sentAt?: number;
}

/** Tears down a subscription. Idempotent: calling it more than once is a no-op. */
export type Unsubscribe = () => void;

/** Receives notifications routed to a subscriber. */
export type NotificationHandler = (notification: Notification) => void;

/** The lifecycle state of a {@link NotificationClient}'s underlying transport. */
export type NotificationClientState = "idle" | "connecting" | "open" | "closed";

/**
 * A client-side delivery channel. Subscribe to one or more channels, or observe every
 * inbound notification regardless of channel, and manage the underlying connection.
 */
export interface NotificationClient {
  /** The current transport lifecycle state. */
  readonly state: NotificationClientState;

  /**
   * Routes notifications on `channel` to `handler`. Returns an {@link Unsubscribe} that
   * removes this specific handler.
   */
  subscribe(channel: string, handler: NotificationHandler): Unsubscribe;

  /**
   * Observes every inbound notification, regardless of channel. Returns an
   * {@link Unsubscribe} that removes this specific handler.
   */
  onNotification(handler: NotificationHandler): Unsubscribe;

  /** Opens the underlying transport. Idempotent; safe to call when already open. */
  connect(): void;

  /** Closes the underlying transport. Subscriptions are left intact for a later reconnect. */
  close(): void;
}
