import type {
  EvaluationContext,
  FeatureFlagManager,
  FlagValue,
  JsonValue,
} from "../featureflags.js";

/**
 * Implements the typed variation helpers in terms of {@link evaluate}, so each provider only
 * has to define `evaluate` and `allFlags`. Each helper falls back to the caller's default
 * when the resolved value's runtime type doesn't match the requested one.
 */
export abstract class BaseFeatureFlagManager implements FeatureFlagManager {
  abstract evaluate<T extends FlagValue>(
    key: string,
    defaultValue: T,
    context?: EvaluationContext,
  ): Promise<T>;

  abstract allFlags(context?: EvaluationContext): Promise<Record<string, FlagValue>>;

  async boolVariation(
    key: string,
    defaultValue: boolean,
    context?: EvaluationContext,
  ): Promise<boolean> {
    const value = await this.evaluate<FlagValue>(key, defaultValue, context);
    return typeof value === "boolean" ? value : defaultValue;
  }

  async stringVariation(
    key: string,
    defaultValue: string,
    context?: EvaluationContext,
  ): Promise<string> {
    const value = await this.evaluate<FlagValue>(key, defaultValue, context);
    return typeof value === "string" ? value : defaultValue;
  }

  async numberVariation(
    key: string,
    defaultValue: number,
    context?: EvaluationContext,
  ): Promise<number> {
    const value = await this.evaluate<FlagValue>(key, defaultValue, context);
    return typeof value === "number" ? value : defaultValue;
  }

  async jsonVariation<T extends JsonValue>(
    key: string,
    defaultValue: T,
    context?: EvaluationContext,
  ): Promise<T> {
    return this.evaluate<T>(key, defaultValue, context);
  }
}
