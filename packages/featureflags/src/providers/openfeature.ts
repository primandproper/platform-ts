import type {
  Client,
  EvaluationContext as OpenFeatureEvaluationContext,
} from "@openfeature/server-sdk";
import {
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
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(client: Client, deps: ObservabilityDeps = {}) {
    super();
    this.#client = client;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  #context(context?: EvaluationContext): OpenFeatureEvaluationContext {
    return toOpenFeatureContext(context);
  }

  override async evaluate<T extends FlagValue>(
    key: string,
    defaultValue: T,
    context?: EvaluationContext,
  ): Promise<T> {
    switch (typeof defaultValue) {
      case "boolean":
        return (await this.#client.getBooleanValue(
          key,
          defaultValue,
          this.#context(context),
        )) as T;
      case "number":
        return (await this.#client.getNumberValue(
          key,
          defaultValue,
          this.#context(context),
        )) as T;
      case "string":
        return (await this.#client.getStringValue(
          key,
          defaultValue,
          this.#context(context),
        )) as T;
      default: {
        const result = await this.#client.getObjectValue(
          key,
          defaultValue,
          this.#context(context),
        );
        return result as T;
      }
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
