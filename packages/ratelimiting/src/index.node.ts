import type { ObservabilityDeps } from "@primandproper/observability";

import { NodeRateLimitConfigSchema, type NodeRateLimitConfigInput } from "./config.js";
import { MemoryRateLimiter } from "./providers/memory.js";
import { NoopRateLimiter } from "./providers/noop.js";
import { RedisRateLimiter } from "./providers/redis.node.js";
import type { RateLimiter } from "./ratelimiting.js";

export * from "./ratelimiting.js";
export * from "./config.js";

/**
 * Node default factory: validates config and returns the matching provider. Mirrors the Go
 * platform's `ProvideRateLimiter`. Supports `memory` (default), `redis`, and `noop`.
 */
export function provideRateLimiter(
  config?: NodeRateLimitConfigInput,
  deps?: ObservabilityDeps,
): RateLimiter {
  const cfg = NodeRateLimitConfigSchema.parse(config ?? {});
  switch (cfg.provider) {
    case "memory":
      return new MemoryRateLimiter({ limit: cfg.limit, windowMs: cfg.windowMs }, deps);
    case "redis":
      // superRefine guarantees this, but narrow for the type checker.
      if (cfg.redis === undefined) {
        throw new Error("redis config is required when provider is 'redis'");
      }
      return new RedisRateLimiter(
        {
          url: cfg.redis.url,
          keyPrefix: cfg.redis.keyPrefix,
          limit: cfg.limit,
          windowMs: cfg.windowMs,
        },
        deps,
      );
    case "noop":
      return new NoopRateLimiter({ limit: cfg.limit });
  }
}
