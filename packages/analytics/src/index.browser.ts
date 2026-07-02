import type { ObservabilityDeps } from "@primandproper/observability";

import type { EventReporter } from "./analytics.js";
import {
  BrowserAnalyticsConfigSchema,
  type BrowserAnalyticsConfigInput,
} from "./config.js";
import { ConsoleReporter } from "./providers/console.js";
import { InMemoryReporter } from "./providers/memory.js";
import { NoopReporter } from "./providers/noop.js";

export * from "./analytics.js";
export * from "./config.js";

/**
 * Browser default factory: validates config and returns the matching provider. Supports
 * `noop` (default), `memory`, and `console`. Same shape as the Node factory, so call-site
 * code is identical across environments.
 *
 * Future extension: SDK-backed browser providers from the catalog — Segment
 * (`@segment/analytics-next`), PostHog (`posthog-js`), and Rudderstack
 * (`@rudderstack/analytics-js`). Each would be a `*.browser.ts` provider added to this
 * switch and the config enum; they are deliberately omitted today to keep external
 * dependencies at zero (only zod + observability).
 */
export function provideAnalytics(
  config?: BrowserAnalyticsConfigInput,
  deps?: ObservabilityDeps,
): EventReporter {
  const cfg = BrowserAnalyticsConfigSchema.parse(config ?? {});
  switch (cfg.provider) {
    case "noop":
      return new NoopReporter();
    case "memory":
      return new InMemoryReporter();
    case "console":
      return new ConsoleReporter(deps);
  }
}
