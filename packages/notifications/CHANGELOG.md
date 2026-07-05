# @primandproper/notifications

## 0.1.0

### Minor Changes

- db7c3ec: rewrite `notifications` as a faithful port of `platform-go/notifications`. **Breaking:** the previous
  isomorphic client-subscriber (`NotificationClient` with `subscribe`/`onNotification`/`connect` over a
  browser WebSocket, plus `memory`/`websocket`/`noop` providers) is replaced by Go's actual server-side
  shape. The package is now **server-only**.

  Two concerns, mirroring Go's `async` and `mobile` subpackages:

  - **Async notifier** — `AsyncNotifier.publish(channel, event)` / `close()` with an `AsyncEvent`
    (`{ type, data? }`). Providers: **pusher** (`pusher` SDK), **ably** (`ably` REST), and **noop**.
    Both vendor providers expose Go's testability seams (`PusherClient` / `ChannelPublisher`) so they
    unit-test against injected fakes. `provideAsyncNotifier(config, deps)` mirrors Go's
    `ProvideAsyncNotifier`.
  - **Mobile push** — `PushNotificationSender.sendPush(platform, token, msg)` with `PushMessage` and
    the `MobileNotificationRequest` DTO. `MultiPlatformPushSender` routes `ios`→APNs
    (`@parse/node-apn`) and `android`→FCM (`firebase-admin`), each behind an injectable client seam;
    `ErrPlatformNotSupported` mirrors Go's sentinel. `providePushSender(config, deps)` mirrors Go's
    `ProvidePushSender`, initializing each platform independently and falling back to noop when neither
    is available.

  Observability is wired to the same depth as Go: every notifier/sender holds an `Observer`, wraps
  each publish/send in `observer.run(...)` with the same span attributes (`channel`, `platform`,
  `event.type`, `apnsID`/`reason`, `fcm.message_id`), records failures via `op.error`, and mints the
  `{o11yName}_sends` / `_errors` counters Go creates with `NewInt64Counter`. o11y names match Go
  (`async_notifications_pusher`, `async_notifications_ably`, `ios_notif_sender`,
  `android_notif_sender`, `mobile_push_sender`).

  **Out of scope:** the `websocket` and `sse` async notifiers. They require server-side connection
  management + an HTTP-request upgrade, which the server framework owns (the same reason `routing` and
  `server` are not ported). The `ConnectionAcceptor` interface is defined for parity, and the two
  provider values are accepted by the config schema but rejected by the factory with a clear error.
