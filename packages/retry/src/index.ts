import { RetryConfigSchema, type RetryConfigInput } from "./config.js";
import { exponentialBackoff, type Policy, type RetryDeps } from "./retry.js";

export * from "./config.js";
export * from "./retry.js";

/** Validates config (applying defaults) and returns an exponential-backoff policy. */
export function providePolicy(config?: RetryConfigInput, deps?: RetryDeps): Policy {
  return exponentialBackoff(RetryConfigSchema.parse(config ?? {}), deps);
}
