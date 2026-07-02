import type { ObservabilityDeps } from "@primandproper/observability";

import { NotificationConfigSchema, type NotificationConfigInput } from "./config.js";
import type { NotificationClient } from "./notifications.js";
import { InMemoryNotificationClient } from "./providers/memory.js";
import { NoopNotificationClient } from "./providers/noop.js";
import { WebSocketNotificationClient } from "./providers/websocket.js";

export * from "./config.js";
export * from "./notification-parse.js";
export * from "./notifications.js";
export * from "./providers/memory.js";
export * from "./providers/noop.js";
export * from "./providers/websocket.js";

/**
 * Node default factory: validates config and returns the matching provider. Mirrors the Go
 * platform's `ProvideNotificationClient`. Supports `memory` (default), `websocket`, and
 * `noop`. The signature is identical to the browser factory, so call-site code is portable.
 *
 * Future SaaS providers from the catalog would slot in here as additional `provider` keys —
 * e.g. `"pusher"` (`pusher-js`) and `"ably"` (`ably`) — but their SDKs are intentionally not
 * a dependency yet, so the package carries zero external runtime deps.
 */
export function provideNotificationClient(
  config?: NotificationConfigInput,
  deps?: ObservabilityDeps,
): NotificationClient {
  const cfg = NotificationConfigSchema.parse(config ?? {});
  switch (cfg.provider) {
    case "memory":
      return new InMemoryNotificationClient(deps);
    case "websocket":
      // superRefine guarantees this, but narrow for the type checker.
      if (cfg.websocket === undefined) {
        throw new Error("websocket config is required when provider is 'websocket'");
      }
      return new WebSocketNotificationClient({ url: cfg.websocket.url }, deps);
    case "noop":
      return new NoopNotificationClient();
  }
}
