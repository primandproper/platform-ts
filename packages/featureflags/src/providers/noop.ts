import type { FlagValue } from "../featureflags.js";

import { BaseFeatureFlagManager } from "./base.js";

/** Universal manager that knows no flags; every evaluation returns the caller's default. */
export class NoopFeatureFlagManager extends BaseFeatureFlagManager {
  override evaluate<T extends FlagValue>(_key: string, defaultValue: T): Promise<T> {
    return Promise.resolve(defaultValue);
  }

  override allFlags(): Promise<Record<string, FlagValue>> {
    return Promise.resolve({});
  }
}
