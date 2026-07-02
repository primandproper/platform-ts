import { LaunchDarklyProvider } from "@launchdarkly/openfeature-node-server";
import { OpenFeature } from "@openfeature/server-sdk";
import type { ObservabilityDeps } from "@primandproper/observability";

import type { FeatureFlagManager } from "../featureflags.js";

import { OpenFeatureFeatureFlagManager } from "./openfeature.js";

/**
 * OpenFeature client domain for the LaunchDarkly provider. A dedicated domain isolates this
 * provider's registration from any other OpenFeature client in the process, mirroring the Go
 * platform's `clientDomain`.
 */
const CLIENT_DOMAIN = "launchdarkly_feature_flags";

export interface LaunchDarklyOptions {
  /** LaunchDarkly server-side SDK key. */
  sdkKey: string;
  /**
   * Seconds to wait for the SDK to initialize before returning. Evaluations issued before the
   * SDK is ready fall back to the caller's default. Defaults to the provider's own 10s.
   */
  initTimeoutSeconds?: number | undefined;
}

/**
 * Builds a LaunchDarkly-backed manager: it constructs the LaunchDarkly OpenFeature provider,
 * registers it under a dedicated client domain, and waits for initialization — the analogue of
 * the Go platform's `SetNamedProviderAndWait` — before returning a manager bound to the
 * resulting OpenFeature client.
 */
export async function provideLaunchDarklyFeatureFlags(
  options: LaunchDarklyOptions,
  deps: ObservabilityDeps = {},
): Promise<FeatureFlagManager> {
  const provider = new LaunchDarklyProvider(
    options.sdkKey,
    {},
    options.initTimeoutSeconds,
  );
  await OpenFeature.setProviderAndWait(CLIENT_DOMAIN, provider);
  return new OpenFeatureFeatureFlagManager(OpenFeature.getClient(CLIENT_DOMAIN), deps);
}
