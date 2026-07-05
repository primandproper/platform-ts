import {
  NOOP_PROVIDER,
  OpenFeature,
  type Client,
  type EvaluationDetails,
  type EvaluationContext as OpenFeatureEvaluationContext,
} from "@openfeature/server-sdk";
import type { Counter } from "@opentelemetry/api";
import {
  makeMetrics,
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type { EvaluationContext, FlagValue } from "../featureflags.js";

import { BaseFeatureFlagManager } from "./base.js";

const o11yName = "featureflags";

/**
 * The OpenFeature evaluation-context shape: a `targetingKey` plus a flat bag of attributes.
 */
export type OpenFeatureContext = { targetingKey?: string } & Record<string, FlagValue>;

/**
 * Maps our platform {@link EvaluationContext} onto OpenFeature's representation. This is the
 * single boundary between the platform-owned type and OpenFeature's, mirroring the Go
 * platform's `toOpenFeatureContext`. Our `key` wins over any attribute literally named
 * `targetingKey`.
 */
export function toOpenFeatureContext(context?: EvaluationContext): OpenFeatureContext {
  const attributes = context?.attributes ?? {};
  return context?.key !== undefined
    ? { ...attributes, targetingKey: context.key }
    : { ...attributes };
}

/**
 * Makes an OpenFeature server client (`@openfeature/server-sdk`) the evaluation engine, exactly
 * as the Go platform's providers delegate to an `*openfeature.Client`. The LaunchDarkly and
 * PostHog factories wrap their vendor SDK in an OpenFeature provider and hand the resulting
 * client here. Evaluation is stateless: the per-call context is forwarded to the client, so a
 * single manager serves many subjects.
 */
export class OpenFeatureFeatureFlagManager extends BaseFeatureFlagManager {
  readonly #client: Client;
  readonly #domain: string | undefined;
  readonly #observer: Observer;
  readonly #logger: Logger;
  readonly #errors: Counter;

  /**
   * `domain` is the OpenFeature client domain this manager's provider is registered under. When
   * supplied (by the LaunchDarkly/PostHog factories, each of which mints a unique domain), {@link
   * close} tears down that domain's provider; when omitted (bare client, e.g. tests) close is a
   * no-op since the manager doesn't own the provider lifecycle.
   */
  constructor(client: Client, deps: ObservabilityDeps = {}, domain?: string) {
    super();
    this.#client = client;
    this.#domain = domain;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
    this.#errors = makeMetrics(o11yName, deps.metrics).counter(
      "featureflags.evaluation.errors",
      {
        description:
          "Feature flag evaluations that fell back to the default due to an error",
      },
    );
  }

  /**
   * Shuts the backing provider down by rebinding this manager's (unique) domain to the noop
   * provider: OpenFeature calls the displaced provider's `onClose`, which flushes the vendor SDK's
   * buffered events and stops its background pollers. Scoped to our own domain, so it never tears
   * down another manager's provider (unlike the process-global `OpenFeature.close()`).
   */
  override async close(): Promise<void> {
    if (this.#domain === undefined) {
      return;
    }
    try {
      await OpenFeature.setProviderAndWait(this.#domain, NOOP_PROVIDER);
    } catch (err) {
      this.#logger.error("closing feature flag provider", err, { domain: this.#domain });
    }
  }

  #context(context?: EvaluationContext): OpenFeatureEvaluationContext {
    return toOpenFeatureContext(context);
  }

  override async evaluate<T extends FlagValue>(
    key: string,
    defaultValue: T,
    context?: EvaluationContext,
  ): Promise<T> {
    // Use the *Details variants (not *Value) so provider errors — a down LaunchDarkly, an
    // unready provider — surface via `errorCode`/`reason` instead of being swallowed into a
    // silent default per the OpenFeature spec.
    const details = await this.#details(key, defaultValue, this.#context(context));
    if (details.errorCode !== undefined) {
      this.#errors.add(1, { error_code: details.errorCode });
      this.#logger.warn("feature flag evaluation error; returning default", {
        key,
        error_code: details.errorCode,
        error_message: details.errorMessage,
        reason: details.reason,
      });
    }
    return details.value as T;
  }

  #details(
    key: string,
    defaultValue: FlagValue,
    context: OpenFeatureEvaluationContext,
  ): Promise<EvaluationDetails<FlagValue>> {
    switch (typeof defaultValue) {
      case "boolean":
        return this.#client.getBooleanDetails(key, defaultValue, context);
      case "number":
        return this.#client.getNumberDetails(key, defaultValue, context);
      case "string":
        return this.#client.getStringDetails(key, defaultValue, context);
      default:
        return this.#client.getObjectDetails(key, defaultValue, context);
    }
  }

  /**
   * OpenFeature's standard client exposes no flag enumeration — bulk listing is a
   * provider-SDK concern (LaunchDarkly's `allFlagsState`, etc.) outside the OpenFeature
   * contract — so this returns an empty map rather than guessing. Evaluate known keys with
   * the typed variation methods instead.
   */
  override allFlags(): Promise<Record<string, FlagValue>> {
    this.#logger.debug(
      "allFlags is unsupported by OpenFeature-backed providers; returning empty map",
    );
    return Promise.resolve({});
  }
}
