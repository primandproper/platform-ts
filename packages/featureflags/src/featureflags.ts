/**
 * The universal feature-flag contract. An unknown or missing flag returns the caller's
 * provided default rather than a sentinel error — the idiomatic-TypeScript divergence from
 * the Go platform, mirroring `cache`'s `undefined`-on-miss convention.
 */

/** The set of JSON-serializable values a flag can evaluate to. */
export type FlagValue = JsonValue;

/** A JSON value, the widest shape a `jsonVariation` may return. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * The subject a flag is evaluated against. `key` identifies the unit being targeted
 * (typically a user or account id); `attributes` carry arbitrary traits a provider may use
 * for targeting rules. Both are optional — anonymous evaluation falls back to defaults.
 */
export interface EvaluationContext {
  key?: string;
  attributes?: Record<string, FlagValue>;
}

/**
 * Evaluates feature flags. Every variation method returns the caller's `defaultValue` when
 * the flag is unknown or the provider is unreachable, so call sites never branch on errors.
 * The typed helpers (`boolVariation`, etc.) are conveniences over {@link evaluate}.
 */
export interface FeatureFlagManager {
  boolVariation(
    key: string,
    defaultValue: boolean,
    context?: EvaluationContext,
  ): Promise<boolean>;

  stringVariation(
    key: string,
    defaultValue: string,
    context?: EvaluationContext,
  ): Promise<string>;

  numberVariation(
    key: string,
    defaultValue: number,
    context?: EvaluationContext,
  ): Promise<number>;

  /**
   * Evaluates a structured (JSON) flag. The result is asserted to `T`; the caller owns the
   * shape contract, as the provider only guarantees a JSON value.
   */
  jsonVariation<T extends JsonValue>(
    key: string,
    defaultValue: T,
    context?: EvaluationContext,
  ): Promise<T>;

  /**
   * The generic evaluation primitive the typed helpers delegate to. Returns `defaultValue`
   * when the flag is unknown or evaluates to an incompatible type.
   */
  evaluate<T extends FlagValue>(
    key: string,
    defaultValue: T,
    context?: EvaluationContext,
  ): Promise<T>;

  /** Returns every known flag evaluated for the given context. */
  allFlags(context?: EvaluationContext): Promise<Record<string, FlagValue>>;
}
