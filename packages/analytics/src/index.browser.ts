import type { ObservabilityDeps } from "@primandproper/observability";

import type { EventReporter } from "./analytics.js";
import { AnalyticsConfigSchema, type AnalyticsConfigInput } from "./config.js";
import { ConsoleReporter } from "./providers/console.js";
import { InMemoryReporter } from "./providers/memory.js";
import { MultiSourceReporter } from "./providers/multisource.js";
import { NoopReporter } from "./providers/noop.js";
import { providePostHog } from "./providers/posthog.browser.js";
import { provideSegment } from "./providers/segment.browser.js";

export * from "./analytics.js";
export * from "./config.js";
export { MultiSourceReporter, SOURCE_PROPERTY_KEY } from "./providers/multisource.js";

/**
 * Browser factory: validates config and returns the matching provider. Supports `noop` (default),
 * `memory`, `console`, `segment` (`@segment/analytics-next`), and `posthog` (`posthog-js`). Same
 * signature as the Node factory, so call-site code is identical across environments — only the
 * default vendor SDK differs, resolved at build time via the package's conditional `exports`.
 */
export function provideAnalytics(
  config?: AnalyticsConfigInput,
  deps?: ObservabilityDeps,
): EventReporter {
  const cfg = AnalyticsConfigSchema.parse(config ?? {});
  switch (cfg.provider) {
    case "noop":
      return new NoopReporter();
    case "memory":
      return new InMemoryReporter();
    case "console":
      return new ConsoleReporter(deps);
    case "segment":
      // Presence guaranteed by the schema's superRefine; re-guarded for the type system.
      if (!cfg.segment) {
        throw new Error("segment config is required when provider is 'segment'");
      }
      return provideSegment(cfg.segment, deps);
    case "posthog":
      if (!cfg.posthog) {
        throw new Error("posthog config is required when provider is 'posthog'");
      }
      return providePostHog(cfg.posthog, deps);
  }
}

/**
 * Builds a {@link MultiSourceReporter} from a map of source name to config, one reporter per source
 * via {@link provideAnalytics}. A source whose config fails to construct degrades to a noop reporter,
 * never failing the whole build — mirrors the Go platform's `ProvideMultiSourceEventReporter`.
 */
export function provideMultiSourceAnalytics(
  sources: Record<string, AnalyticsConfigInput>,
  deps?: ObservabilityDeps,
): MultiSourceReporter {
  const reporters: Record<string, EventReporter> = {};
  for (const [source, config] of Object.entries(sources)) {
    try {
      reporters[source] = provideAnalytics(config, deps);
    } catch {
      reporters[source] = new NoopReporter();
    }
  }
  return new MultiSourceReporter(reporters, deps);
}
