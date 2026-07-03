import type { ObservabilityDeps } from "@primandproper/observability";
import { PostHog } from "posthog-node";

import type { EventContext, EventReporter } from "../analytics.js";
import type { PostHogConfig } from "../config.js";

import { VendorReporter } from "./vendor.js";

/** PostHog Cloud host; Go's default. */
const DEFAULT_HOST = "https://app.posthog.com";
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
export function providePostHog(config: PostHogConfig, deps: ObservabilityDeps = {}): EventReporter {
  const client = new PostHog(config.apiKey, { host: config.host ?? DEFAULT_HOST });
  return new VendorReporter(
    "posthog",
    {
      track(event, properties, context) {
        client.capture({ distinctId: distinctId(context), event, ...(properties ? { properties } : {}) });
      },
      identify(userId, traits) {
        client.identify({ distinctId: userId, ...(traits ? { properties: traits } : {}) });
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
      shutdown: () => client.shutdown(),
    },
    deps,
  );
}
