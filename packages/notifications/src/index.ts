import { makeObserver, type ObservabilityDeps } from "@primandproper/observability";

import type { AsyncNotifier } from "./async.js";
import {
  AsyncNotifierConfigSchema,
  type AsyncNotifierConfigInput,
  PushSenderConfigSchema,
  type PushSenderConfigInput,
} from "./config.js";
import { MultiPlatformPushSender, type PushNotificationSender } from "./mobile.js";
import { AblyAsyncNotifier, newChannelPublisher } from "./providers/ably.node.js";
import { ApnsSender, newApnsClient } from "./providers/apns.node.js";
import { NoopAsyncNotifier } from "./providers/async-noop.js";
import { FcmSender, newFcmClient } from "./providers/fcm.node.js";
import { NoopPushNotificationSender } from "./providers/mobile-noop.js";
import { newPusherClient, PusherAsyncNotifier } from "./providers/pusher.node.js";

export * from "./async.js";
export * from "./mobile.js";
export * from "./config.js";

export { NoopAsyncNotifier } from "./providers/async-noop.js";
export { NoopPushNotificationSender } from "./providers/mobile-noop.js";
export {
  PusherAsyncNotifier,
  newPusherClient,
  type PusherAsyncNotifierOptions,
  type PusherClient,
} from "./providers/pusher.node.js";
export {
  AblyAsyncNotifier,
  newChannelPublisher,
  type AblyAsyncNotifierOptions,
  type ChannelPublisher,
} from "./providers/ably.node.js";
export {
  ApnsSender,
  newApnsClient,
  type ApnsClient,
  type ApnsConfig,
  type ApnsNotification,
  type ApnsPushResult,
} from "./providers/apns.node.js";
export {
  FcmSender,
  newFcmClient,
  type FcmClient,
  type FcmConfig,
  type FcmMessage,
} from "./providers/fcm.node.js";

const mobileO11yName = "mobile_push_sender";

/**
 * Validates config and returns the matching {@link AsyncNotifier}. Faithful to Go's
 * `ProvideAsyncNotifier`. `noop` (default) needs no config; `pusher` and `ably` require their
 * block (enforced by the schema). `websocket`/`sse` are out of scope — see
 * {@link import("./async.js").ConnectionAcceptor}.
 */
export function provideAsyncNotifier(
  config?: AsyncNotifierConfigInput,
  deps?: ObservabilityDeps,
): AsyncNotifier {
  const cfg = AsyncNotifierConfigSchema.parse(config ?? {});
  switch (cfg.provider) {
    case "pusher":
      return new PusherAsyncNotifier(
        newPusherClient(required(cfg.pusher, "pusher")),
        deps,
      );
    case "ably":
      return new AblyAsyncNotifier(newChannelPublisher(required(cfg.ably, "ably")), deps);
    case "websocket":
    case "sse":
      throw new Error(
        `async notifier provider '${cfg.provider}' is not implemented in platform-ts: ` +
          "server-side connection management + HTTP upgrade is owned by the server framework",
      );
    case "noop":
      return new NoopAsyncNotifier();
  }
}

/**
 * Validates config and returns the matching {@link PushNotificationSender}. Faithful to Go's
 * `ProvidePushSender`: under `apns_fcm` each platform is initialized independently and a failed
 * init disables only that platform; when neither platform is available it falls back to noop.
 */
export function providePushSender(
  config?: PushSenderConfigInput,
  deps?: ObservabilityDeps,
): PushNotificationSender {
  const cfg = PushSenderConfigSchema.parse(config ?? {});
  if (cfg.provider === "noop") {
    return new NoopPushNotificationSender();
  }

  const logger = (deps?.observer ?? makeObserver(mobileO11yName, deps)).logger();

  let apnsSender: ApnsSender | undefined;
  if (cfg.apns !== undefined) {
    try {
      apnsSender = new ApnsSender(newApnsClient(cfg.apns), cfg.apns.bundleID, deps);
    } catch (err) {
      logger.with({ error: err }).debug("APNs sender init failed, iOS push disabled");
    }
  }

  let fcmSender: FcmSender | undefined;
  if (cfg.fcm !== undefined) {
    try {
      fcmSender = new FcmSender(newFcmClient(cfg.fcm), deps);
    } catch (err) {
      logger.with({ error: err }).debug("FCM sender init failed, Android push disabled");
    }
  }

  if (apnsSender === undefined && fcmSender === undefined) {
    logger.debug("no platform senders available, using noop");
    return new NoopPushNotificationSender();
  }

  return new MultiPlatformPushSender(apnsSender, fcmSender, deps);
}

/** Narrows a per-provider config the schema's `superRefine` already guaranteed present. */
function required<T>(value: T | undefined, provider: string): T {
  if (value === undefined) {
    throw new Error(`${provider} config is required when provider is '${provider}'`);
  }
  return value;
}
