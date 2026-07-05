import type { ObservabilityDeps } from "@primandproper/observability";
import { PostHog } from "posthog-node";

import type { EventContext, EventReporter } from "../analytics.js";
import type { PostHogConfig } from "../config.js";

import { DEFAULT_ANALYTICS_TIMEOUT_MS, VendorReporter } from "./vendor.js";

/** PostHog Cloud host; Go's default. */
const DEFAULT_HOST = "https://us.i.posthog.com";
/** PostHog keys every event to a distinct id; used when the caller supplies neither id. */
const FALLBACK_DISTINCT_ID = "anonymous";

/** PostHog uses a single `distinctId` for identified and anonymous events alike. */
function distinctId(context: EventContext | undefined): string {
  return context?.userId ?? context?.anonymousId ?? FALLBACK_DISTINCT_ID;
}

/**
 * Builds a PostHog-backed reporter over `posthog-node`. Pages and screens map to PostHog's
 * `$pageview` / `$screen` events. `flush()` drains the buffer; `shutdown()` flushes and stops the
 * background sender. Mirrors the Go platform's PostHog provider (default endpoint included).
 */
export function providePostHog(
  config: PostHogConfig,
  deps: ObservabilityDeps = {},
): EventReporter {
  const client = new PostHog(config.apiKey, { host: config.host ?? DEFAULT_HOST });
  const reporter = new VendorReporter(
    "posthog",
    {
      track(event, properties, context) {
        client.capture({
          distinctId: distinctId(context),
          event,
          ...(properties ? { properties } : {}),
        });
      },
      identify(userId, traits) {
        client.identify({
          distinctId: userId,
          ...(traits ? { properties: traits } : {}),
        });
      },
      page(name, properties, context) {
        client.capture({
          distinctId: distinctId(context),
          event: "$pageview",
          properties: { $screen_name: name, ...properties },
        });
      },
      screen(name, properties, context) {
        client.capture({
          distinctId: distinctId(context),
          event: "$screen",
          properties: { $screen_name: name, ...properties },
        });
      },
      flush: () => client.flush(),
      // Pass the deadline into posthog-node so the SDK itself gives up on a stuck flush, rather
      // than relying only on the reporter-level race to abandon it.
      shutdown: () => client.shutdown(DEFAULT_ANALYTICS_TIMEOUT_MS),
    },
    deps,
  );
  // posthog-node delivers batches on a background timer; delivery failures only ever surface on the
  // client's `error` event, so surface them through the reporter instead of letting them vanish.
  client.on("error", (err) => {
    reporter.onBackgroundError(err);
  });
  return reporter;
}
