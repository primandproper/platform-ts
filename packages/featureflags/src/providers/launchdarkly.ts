import { LaunchDarklyProvider } from "@launchdarkly/openfeature-node-server";
import { OpenFeature } from "@openfeature/server-sdk";
import {
  ensureLogger,
  type Logger,
  type ObservabilityDeps,
} from "@primandproper/observability";

import type { FeatureFlagManager } from "../featureflags.js";

import { OpenFeatureFeatureFlagManager } from "./openfeature.js";

/**
 * Adapts a platform {@link Logger} to the LaunchDarkly SDK's variadic logger shape so the SDK's
 * own diagnostics (init failures, streaming errors) route through the injected logger instead of
 * its console fallback. LD passes a message plus arbitrary args, which we join into one line.
 */
function toLaunchDarklyLogger(logger: Logger) {
  const line = (args: unknown[]): string => args.map((arg) => String(arg)).join(" ");
  return {
    error: (...args: unknown[]): void => {
      logger.error(line(args));
    },
    warn: (...args: unknown[]): void => {
      logger.warn(line(args));
    },
    info: (...args: unknown[]): void => {
      logger.info(line(args));
    },
    debug: (...args: unknown[]): void => {
      logger.debug(line(args));
    },
  };
}

/**
 * Base for the OpenFeature client domain of each LaunchDarkly manager. A per-call unique suffix is
 * appended so a second construction registers under its own domain instead of silently rebinding
 * (and closing) the first manager's provider — the isolation the constant Go `clientDomain` lacks.
 */
const CLIENT_DOMAIN_BASE = "launchdarkly_feature_flags";

let instanceCount = 0;

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
    { logger: toLaunchDarklyLogger(ensureLogger(deps.logger)) },
    options.initTimeoutSeconds,
  );
  instanceCount += 1;
  const domain = `${CLIENT_DOMAIN_BASE}_${instanceCount.toString()}`;
  await OpenFeature.setProviderAndWait(domain, provider);
  return new OpenFeatureFeatureFlagManager(OpenFeature.getClient(domain), deps, domain);
}
