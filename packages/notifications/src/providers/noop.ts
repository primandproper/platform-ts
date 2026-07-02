import type {
  NotificationClient,
  NotificationClientState,
  Unsubscribe,
} from "../notifications.js";

/** Universal client that delivers nothing; every subscription is inert. */
export class NoopNotificationClient implements NotificationClient {
  readonly state: NotificationClientState = "idle";

  subscribe(): Unsubscribe {
    return () => {
      /* nothing subscribed */
    };
  }

  onNotification(): Unsubscribe {
    return () => {
      /* nothing subscribed */
    };
  }

  connect(): void {}

  close(): void {}
}
