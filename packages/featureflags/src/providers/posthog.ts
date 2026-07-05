import { OpenFeature } from "@openfeature/server-sdk";
import type { ObservabilityDeps } from "@primandproper/observability";
import { PostHogProvider } from "@tapico/node-openfeature-posthog";

import type { FeatureFlagManager } from "../featureflags.js";

import { OpenFeatureFeatureFlagManager } from "./openfeature.js";

/**
 * Base for the OpenFeature client domain of each PostHog manager. A per-call unique suffix is
 * appended so a second construction registers under its own domain instead of silently rebinding
 * (and closing) the first manager's provider — the isolation the constant Go `clientDomain` lacks.
 */
const CLIENT_DOMAIN_BASE = "posthog_feature_flags";

let instanceCount = 0;

export interface PostHogOptions {
  /** PostHog project API key, used for event capture. */
  projectApiKey: string;
  /** PostHog personal API key; required to evaluate feature flags. */
  personalApiKey: string;
  /** Host of a self-hosted PostHog instance. Defaults to PostHog Cloud. */
  host?: string | undefined;
  /**
   * Evaluate flags locally from the polled definitions instead of issuing a remote decide call
   * per evaluation. Faster, at the cost of a short propagation delay on flag changes.
   */
  evaluateLocally?: boolean | undefined;
}

/**
 * Builds a PostHog-backed manager: the PostHog OpenFeature provider constructs its own
 * `posthog-node` client from these credentials, is registered under a dedicated client domain,
 * and is awaited to readiness before a manager bound to the OpenFeature client is returned.
 * Mirrors the Go platform's PostHog provider (project + personal API keys).
 */
export async function providePostHogFeatureFlags(
  options: PostHogOptions,
  deps: ObservabilityDeps = {},
): Promise<FeatureFlagManager> {
  const provider = new PostHogProvider({
    // Build conditionally so optional keys are omitted rather than set to `undefined`,
    // which `exactOptionalPropertyTypes` rejects.
    posthogConfiguration: {
      apiKey: options.projectApiKey,
      personalApiKey: options.personalApiKey,
      ...(options.evaluateLocally !== undefined
        ? { evaluateLocally: options.evaluateLocally }
        : {}),
      ...(options.host ? { clientOptions: { host: options.host } } : {}),
    },
  });
  instanceCount += 1;
  const domain = `${CLIENT_DOMAIN_BASE}_${instanceCount.toString()}`;
  await OpenFeature.setProviderAndWait(domain, provider);
  return new OpenFeatureFeatureFlagManager(OpenFeature.getClient(domain), deps, domain);
}
