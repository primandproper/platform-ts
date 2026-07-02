import type { ObservabilityDeps } from "@primandproper/observability";

import { FeatureFlagsConfigSchema, type FeatureFlagsConfigInput } from "./config.js";
import type { FeatureFlagManager } from "./featureflags.js";
import { provideLaunchDarklyFeatureFlags } from "./providers/launchdarkly.js";
import { NoopFeatureFlagManager } from "./providers/noop.js";
import { providePostHogFeatureFlags } from "./providers/posthog.js";
import { StaticFeatureFlagManager } from "./providers/static.js";

export * from "./config.js";
export * from "./featureflags.js";
export * from "./providers/base.js";
export * from "./providers/openfeature.js";
export * from "./providers/static.js";
export * from "./providers/noop.js";
export * from "./providers/launchdarkly.js";
export * from "./providers/posthog.js";

/**
 * Default factory: validates config and returns the matching provider. Mirrors the Go
 * platform's `ProvideFeatureFlagManager`. The SDK-backed providers (`launchdarkly`, `posthog`)
 * evaluate through an OpenFeature client and register asynchronously — awaiting provider
 * readiness, the analogue of Go's `SetNamedProviderAndWait` — so this factory is async.
 * `static` (default) and `noop` resolve immediately.
 */
export async function provideFeatureFlags(
  config?: FeatureFlagsConfigInput,
  deps?: ObservabilityDeps,
): Promise<FeatureFlagManager> {
  const cfg = FeatureFlagsConfigSchema.parse(config ?? {});
  switch (cfg.provider) {
    case "static":
      return new StaticFeatureFlagManager({ flags: cfg.flags }, deps);
    case "noop":
      return new NoopFeatureFlagManager();
    case "launchdarkly":
      // Presence is guaranteed by the config schema's superRefine; guard for the type system.
      if (!cfg.launchdarkly) throw new Error("missing launchdarkly config");
      return provideLaunchDarklyFeatureFlags(cfg.launchdarkly, deps);
    case "posthog":
      if (!cfg.posthog) throw new Error("missing posthog config");
      return providePostHogFeatureFlags(cfg.posthog, deps);
  }
}
