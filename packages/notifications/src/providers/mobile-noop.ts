import type { PushNotificationSender } from "../mobile.js";

/**
 * A {@link PushNotificationSender} that sends nothing. Used when neither APNs nor FCM is
 * configured. Go's `mobile/noop`.
 */
export class NoopPushNotificationSender implements PushNotificationSender {
  sendPush(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
