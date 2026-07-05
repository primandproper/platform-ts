import {
  makeMetrics,
  makeObserver,
  type Logger,
  type Metrics,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type { FlagDefinition, FlagRule, FlagTable } from "../config.js";
import type { EvaluationContext, FlagValue } from "../featureflags.js";

import { BaseFeatureFlagManager } from "./base.js";

type Counter = ReturnType<Metrics["counter"]>;

const o11yName = "featureflags";

export interface StaticFeatureFlagsOptions {
  /** The flag table to evaluate against, keyed by flag name. */
  flags?: FlagTable;
}

/**
 * Universal provider that evaluates a static flag table supplied at construction. Each flag
 * is either a bare value or a `{ value, rules }` object; targeting `rules` are matched in
 * order against the evaluation context's attributes, with the first match winning. A missing
 * flag returns the caller's default. Usable on both Node and the browser, and the default
 * provider in both environments.
 */
export class StaticFeatureFlagManager extends BaseFeatureFlagManager {
  readonly #flags: FlagTable;
  readonly #observer: Observer;
  readonly #logger: Logger;
  readonly #errors: Counter;

  constructor(options: StaticFeatureFlagsOptions = {}, deps: ObservabilityDeps = {}) {
    super();
    this.#flags = options.flags ?? {};
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
    this.#errors = makeMetrics(o11yName, deps.metrics).counter(
      "featureflags.evaluation.errors",
      {
        description:
          "Feature-flag evaluations that fell back to the default, by error code.",
      },
    );
  }

  override evaluate<T extends FlagValue>(
    key: string,
    defaultValue: T,
    context?: EvaluationContext,
  ): Promise<T> {
    if (!Object.prototype.hasOwnProperty.call(this.#flags, key)) {
      this.#logger.debug("feature flag not found", { key });
      return Promise.resolve(defaultValue);
    }
    const resolved = resolve(this.#flags[key], context);
    // Guard the cast: a flag whose stored value's type doesn't match the requested type would
    // otherwise be returned as the wrong T. Fall back to the default (mirrors OpenFeature's
    // TYPE_MISMATCH handling from FLAG-1) and surface it via the errors counter.
    if (!sameJsonType(resolved, defaultValue)) {
      this.#errors.add(1, { error_code: "TYPE_MISMATCH" });
      this.#logger.warn("feature flag type mismatch, returning default", {
        key,
        expected: jsonType(defaultValue),
        actual: jsonType(resolved),
      });
      return Promise.resolve(defaultValue);
    }
    return Promise.resolve(resolved as T);
  }

  override allFlags(context?: EvaluationContext): Promise<Record<string, FlagValue>> {
    const out: Record<string, FlagValue> = {};
    for (const [name, definition] of Object.entries(this.#flags)) {
      out[name] = resolve(definition, context);
    }
    return Promise.resolve(out);
  }
}

/** Resolves a flag definition to a value, applying the first matching targeting rule. */
function resolve(
  definition: FlagDefinition | undefined,
  context: EvaluationContext | undefined,
): FlagValue {
  if (definition === undefined) {
    return null;
  }
  if (!isDefinitionObject(definition)) {
    return definition;
  }
  const attributes = context?.attributes ?? {};
  for (const rule of definition.rules) {
    if (matches(rule, attributes)) {
      return rule.value;
    }
  }
  return definition.value;
}

/** The coarse JSON type of a flag value, distinguishing `null`, arrays, and plain objects. */
function jsonType(value: FlagValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** True when two flag values share the same coarse JSON type (used to guard the return cast). */
function sameJsonType(a: FlagValue, b: FlagValue): boolean {
  return jsonType(a) === jsonType(b);
}

/** A rule matches when every attribute it constrains equals the context's attribute. */
function matches(rule: FlagRule, attributes: Record<string, FlagValue>): boolean {
  return Object.entries(rule.when).every(
    ([attr, expected]) => attributes[attr] === expected,
  );
}

function isDefinitionObject(
  definition: FlagDefinition,
): definition is { value: FlagValue; rules: FlagRule[] } {
  return (
    typeof definition === "object" &&
    definition !== null &&
    !Array.isArray(definition) &&
    "value" in definition &&
    "rules" in definition
  );
}
