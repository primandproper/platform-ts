import type { ObservabilityDeps } from "@primandproper/observability";

import type { Cache } from "./cache.js";
import { NodeCacheConfigSchema, type NodeCacheConfigInput } from "./config.js";
import { InMemoryCache } from "./providers/memory.js";
import { NoopCache } from "./providers/noop.js";
import { RedisCache } from "./providers/redis.node.js";

export * from "./cache.js";
export * from "./config.js";

/**
 * Node default factory: validates config and returns the matching provider. Mirrors the Go
 * platform's `ProvideCache`. Supports `memory` (default), `redis`, and `noop`.
 */
export function provideCache<T>(
  config?: NodeCacheConfigInput,
  deps?: ObservabilityDeps,
): Cache<T> {
  const cfg = NodeCacheConfigSchema.parse(config ?? {});
  switch (cfg.provider) {
    case "memory":
      return new InMemoryCache<T>(
        { expiryMs: cfg.expiryMs, maxEntries: cfg.maxEntries },
        deps,
      );
    case "redis":
      // superRefine guarantees this, but narrow for the type checker.
      if (cfg.redis === undefined) {
        throw new Error("redis config is required when provider is 'redis'");
      }
      return new RedisCache<T>(
        {
          url: cfg.redis.url,
          keyPrefix: cfg.redis.keyPrefix,
          expiryMs: cfg.expiryMs,
          ...(cfg.redis.commandTimeoutMs !== undefined
            ? { commandTimeoutMs: cfg.redis.commandTimeoutMs }
            : {}),
          ...(cfg.redis.connectTimeoutMs !== undefined
            ? { connectTimeoutMs: cfg.redis.connectTimeoutMs }
            : {}),
        },
        deps,
      );
    case "noop":
      return new NoopCache<T>();
  }
}
