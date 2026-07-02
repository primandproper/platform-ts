import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type { Notification, NotificationHandler, Unsubscribe } from "../notifications.js";

const o11yName = "notifications";

/**
 * Shared subscription bookkeeping for providers that route notifications locally (the
 * websocket and memory providers). Tracks per-channel handlers plus a set of global
 * observers, and dispatches an inbound {@link Notification} to both. A throwing handler is
 * logged and swallowed so one bad subscriber can't starve the others.
 */
export class SubscriptionRegistry {
  readonly #channels = new Map<string, Set<NotificationHandler>>();
  readonly #observers = new Set<NotificationHandler>();
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(deps: ObservabilityDeps = {}) {
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  subscribe(channel: string, handler: NotificationHandler): Unsubscribe {
    let handlers = this.#channels.get(channel);
    if (handlers === undefined) {
      handlers = new Set();
      this.#channels.set(channel, handlers);
    }
    handlers.add(handler);

    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      const current = this.#channels.get(channel);
      if (current === undefined) {
        return;
      }
      current.delete(handler);
      if (current.size === 0) {
        this.#channels.delete(channel);
      }
    };
  }

  onNotification(handler: NotificationHandler): Unsubscribe {
    this.#observers.add(handler);

    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      this.#observers.delete(handler);
    };
  }

  /** Fan a notification out to its channel's subscribers and every global observer. */
  dispatch(notification: Notification): void {
    for (const handler of this.#observers) {
      this.#invoke(handler, notification);
    }
    const handlers = this.#channels.get(notification.channel);
    if (handlers !== undefined) {
      for (const handler of handlers) {
        this.#invoke(handler, notification);
      }
    }
  }

  #invoke(handler: NotificationHandler, notification: Notification): void {
    try {
      handler(notification);
    } catch (err) {
      this.#logger.error("notification handler threw", err);
    }
  }
}
