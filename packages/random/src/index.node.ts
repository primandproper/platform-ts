import type { ObservabilityDeps } from "@primandproper/observability";

import { RandomConfigSchema, type RandomConfigInput } from "./config.js";
import { NoopGenerator } from "./providers/noop.js";
import { StandardGenerator } from "./providers/standard.js";
import type { RandomGenerator } from "./random.js";

export * from "./config.js";
export * from "./encoding.js";
export * from "./random.js";
export * from "./slices.js";
export { NoopGenerator } from "./providers/noop.js";
export { StandardGenerator } from "./providers/standard.js";

/**
 * Node default factory: validates config and returns the matching {@link RandomGenerator}.
 * Mirrors the Go platform's `Provide*`. `standard` (default) draws from WebCrypto; `noop`
 * returns empty values. Built on WebCrypto, so this entry is identical to the browser entry —
 * call-site code is portable across environments.
 */
export function provideRandomGenerator(
  config?: RandomConfigInput,
  deps?: ObservabilityDeps,
): RandomGenerator {
  const cfg = RandomConfigSchema.parse(config ?? {});
  switch (cfg.provider) {
    case "standard":
      return new StandardGenerator(deps);
    case "noop":
      return new NoopGenerator();
  }
}
