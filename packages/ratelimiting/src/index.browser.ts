import type { ObservabilityDeps } from "@primandproper/observability";

import {
  BrowserRateLimitConfigSchema,
  type BrowserRateLimitConfigInput,
} from "./config.js";
import { MemoryRateLimiter } from "./providers/memory.js";
import { NoopRateLimiter } from "./providers/noop.js";
import type { RateLimiter } from "./ratelimiting.js";

export * from "./ratelimiting.js";
export * from "./config.js";

/**
 * Browser default factory: validates config and returns the matching provider. Supports
 * `memory` (default) and `noop`. Same shape as the Node factory, so call-site code is
 * identical across environments.
 */
export function provideRateLimiter(
  config?: BrowserRateLimitConfigInput,
  deps?: ObservabilityDeps,
): RateLimiter {
  const cfg = BrowserRateLimitConfigSchema.parse(config ?? {});
  switch (cfg.provider) {
    case "memory":
      return new MemoryRateLimiter({ limit: cfg.limit, windowMs: cfg.windowMs }, deps);
    case "noop":
      return new NoopRateLimiter({ limit: cfg.limit });
  }
}
