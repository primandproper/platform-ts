import type { ObservabilityDeps } from "@primandproper/observability";

import type { EventReporter } from "./analytics.js";
import { NodeAnalyticsConfigSchema, type NodeAnalyticsConfigInput } from "./config.js";
import { ConsoleReporter } from "./providers/console.js";
import { InMemoryReporter } from "./providers/memory.js";
import { NoopReporter } from "./providers/noop.js";

export * from "./analytics.js";
export * from "./config.js";

/**
 * Node default factory: validates config and returns the matching provider. Mirrors the Go
 * platform's `ProvideEventReporter`. Supports `noop` (default), `memory`, and `console`.
 *
 * Future extension: SDK-backed server providers from the catalog — Segment
 * (`@segment/analytics-node`), PostHog (`posthog-node`), and Rudderstack
 * (`@rudderstack/rudder-sdk-node`). Each would be a `*.node.ts` provider added to this
 * switch and the config enum; they are deliberately omitted today to keep external
 * dependencies at zero (only zod + observability).
 */
export function provideAnalytics(
  config?: NodeAnalyticsConfigInput,
  deps?: ObservabilityDeps,
): EventReporter {
  const cfg = NodeAnalyticsConfigSchema.parse(config ?? {});
  switch (cfg.provider) {
    case "noop":
      return new NoopReporter();
    case "memory":
      return new InMemoryReporter();
    case "console":
      return new ConsoleReporter(deps);
  }
}
