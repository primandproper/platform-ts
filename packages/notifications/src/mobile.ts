import {
  makeObserver,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type { ApnsSender } from "./providers/apns.node.js";
import type { FcmSender } from "./providers/fcm.node.js";

/**
 * The mobile push contract, ported from platform-go's `notifications/mobile`. A
 * {@link PushNotificationSender} routes by platform: APNs for `ios`, FCM for `android`.
 */

const platformIOS = "ios";
const platformAndroid = "android";
const o11yName = "mobile_push_sender";

/**
 * The content of a push notification. `badgeCount`, when set on iOS, sets the app icon badge.
 * Go's `mobile.PushMessage`.
 */
export interface PushMessage {
  title: string;
  body: string;
  badgeCount?: number;
}

/**
 * The generic message payload for mobile push notifications. `requestType` determines which
 * handler processes the request; schedulers format the message. Go's `MobileNotificationRequest`.
 */
export interface MobileNotificationRequest {
  requestType: string;
  title: string;
  body: string;
  recipientUserIDs: string[];
  context?: Record<string, string>;
  badgeCount?: number;
  testID?: string;
}

/**
 * Sends push notifications to device tokens, routing by platform. Faithful to Go's
 * `mobile.PushNotificationSender`.
 */
export interface PushNotificationSender {
  /**
   * Sends a push notification to a single device token. `platform` is `"ios"` or `"android"`;
   * implementations filter by platform.
   */
  sendPush(platform: string, token: string, msg: PushMessage): Promise<void>;
  /**
   * Releases the platform senders' resources — the APNs HTTP/2 connection pool and the Firebase
   * app — so a graceful shutdown isn't blocked by lingering connections/pollers. Mirrors the
   * `close()` {@link import("./async.js").AsyncNotifier} already carries. Idempotent.
   */
  close(): Promise<void>;
}

/** The message carried by every "platform not supported" error; match on it if needed. */
export const PLATFORM_NOT_SUPPORTED_MESSAGE =
  "push notifications not configured for this platform";

/**
 * Mints a fresh error for sending to a platform that has no configured sender (e.g. an iOS token
 * but APNs unconfigured). Go's `ErrPlatformNotSupported`. A factory, not a shared singleton, so
 * each throw carries a stack captured at the throw site rather than one frozen at module load.
 */
export function newPlatformNotSupportedError(): Error {
  return new Error(PLATFORM_NOT_SUPPORTED_MESSAGE);
}

/**
 * Routes push notifications to APNs (iOS) or FCM (Android). Faithful to Go's
 * `MultiPlatformPushSender`: it lowercases the platform, records it on the operation, and routes
 * to the matching sender — erroring via {@link newPlatformNotSupportedError} when that sender is
 * absent, and on an unknown platform.
 */
export class MultiPlatformPushSender implements PushNotificationSender {
  readonly #apnsSender: ApnsSender | undefined;
  readonly #fcmSender: FcmSender | undefined;
  readonly #observer: Observer;

  constructor(
    apnsSender: ApnsSender | undefined,
    fcmSender: FcmSender | undefined,
    deps?: ObservabilityDeps,
  ) {
    this.#apnsSender = apnsSender;
    this.#fcmSender = fcmSender;
    this.#observer = deps?.observer ?? makeObserver(o11yName, deps);
  }

  sendPush(platform: string, token: string, msg: PushMessage): Promise<void> {
    return this.#observer.run("send_push", async (op) => {
      const normalized = platform.trim().toLowerCase();
      op.set("platform", normalized);

      switch (normalized) {
        case platformIOS:
          if (this.#apnsSender === undefined) {
            throw op.error(newPlatformNotSupportedError(), "sending apns notification");
          }
          return this.#apnsSender.send(token, msg.title, msg.body, msg.badgeCount);
        case platformAndroid:
          if (this.#fcmSender === undefined) {
            throw op.error(newPlatformNotSupportedError(), "sending fcm notification");
          }
          return this.#fcmSender.send(token, msg.title, msg.body);
        default:
          throw op.error(
            new Error(`unknown platform ${JSON.stringify(normalized)}`),
            "routing push notification",
          );
      }
    });
  }

  /** Closes whichever platform senders are configured, so neither leaks its client on shutdown. */
  async close(): Promise<void> {
    await Promise.allSettled([this.#apnsSender?.close(), this.#fcmSender?.close()]);
  }
}
