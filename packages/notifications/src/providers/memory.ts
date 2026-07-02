import type { ObservabilityDeps } from "@primandproper/observability";

import type {
  Notification,
  NotificationClient,
  NotificationClientState,
  NotificationHandler,
  Unsubscribe,
} from "../notifications.js";

import { SubscriptionRegistry } from "./registry.js";

/**
 * Universal in-process pub/sub bus. There's no transport, so `connect`/`close` only flip the
 * reported {@link NotificationClientState}; {@link InMemoryNotificationClient.publish} feeds
 * notifications straight into the registry. Ideal for local dev, SSR, and conformance tests.
 */
export class InMemoryNotificationClient implements NotificationClient {
  readonly #registry: SubscriptionRegistry;
  #state: NotificationClientState = "idle";

  constructor(deps: ObservabilityDeps = {}) {
    this.#registry = new SubscriptionRegistry(deps);
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
    this.#state = "open";
  }

  close(): void {
    this.#state = "closed";
  }

  /**
   * Delivers a notification to the matching channel subscribers and every global observer.
   * The local-only escape hatch the other providers receive over the wire.
   */
  publish(notification: Notification): void {
    this.#registry.dispatch(notification);
  }
}
