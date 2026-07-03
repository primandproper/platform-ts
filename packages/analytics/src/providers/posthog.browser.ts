import type { ObservabilityDeps } from "@primandproper/observability";
import { PostHog } from "posthog-js";

import type { EventProperties, EventReporter } from "../analytics.js";
import type { PostHogConfig } from "../config.js";

import { VendorReporter } from "./vendor.js";

/** PostHog Cloud host; Go's default. */
const DEFAULT_HOST = "https://app.posthog.com";

/**
 * The slice of the `posthog-js` client the adapter calls. `capture`/`identify` accept the browser
 * SDK's own optional-argument shapes; narrowing keeps the adapter readable.
 */
interface PostHogBrowserClient {
  init(apiKey: string, options: { api_host: string }): unknown;
  capture(event: string, properties?: EventProperties): unknown;
  identify(distinctId: string, properties?: EventProperties): unknown;
}

/**
 * Builds a PostHog-backed reporter over `posthog-js`. The browser SDK manages its own distinct id
 * and dispatches events itself, so `flush`/`shutdown` are no-ops. Pages and screens map to
 * `$pageview` / `$screen`. Same factory signature as the Node provider, so call-site code is
 * portable across contexts.
 */
export function providePostHog(config: PostHogConfig, deps: ObservabilityDeps = {}): EventReporter {
  const client = new PostHog() as unknown as PostHogBrowserClient;
  client.init(config.apiKey, { api_host: config.host ?? DEFAULT_HOST });
  return new VendorReporter(
    "posthog",
    {
      track: (event, properties) => void client.capture(event, properties),
      identify: (userId, traits) => void client.identify(userId, traits),
      page: (name, properties) => void client.capture("$pageview", { $screen_name: name, ...properties }),
      screen: (name, properties) => void client.capture("$screen", { $screen_name: name, ...properties }),
      flush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    },
    deps,
  );
}
