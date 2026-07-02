import type { ObservabilityDeps } from "@primandproper/observability";

import { MessageQueueConfigSchema, type MessageQueueConfigInput } from "./config.js";
import type { MessageQueue } from "./messagequeue.js";
import { MemoryMessageQueue } from "./providers/memory.js";
import { NoopMessageQueue } from "./providers/noop.js";
import { RedisMessageQueue } from "./providers/redis.node.js";

export * from "./messagequeue.js";
export * from "./config.js";
export { MemoryMessageQueue } from "./providers/memory.js";
export { NoopMessageQueue } from "./providers/noop.js";
export {
  RedisMessageQueue,
  type RedisMessageQueueOptions,
} from "./providers/redis.node.js";

/**
 * Validates config and returns the matching {@link MessageQueue}. Mirrors the Go platform's
 * `ProvideMessageQueue`. Supports `memory` (default), `redis`, and `noop`.
 */
export function provideMessageQueue(
  config?: MessageQueueConfigInput,
  deps?: ObservabilityDeps,
): MessageQueue {
  const cfg = MessageQueueConfigSchema.parse(config ?? {});
  switch (cfg.provider) {
    case "memory":
      return new MemoryMessageQueue(deps);
    case "redis":
      // superRefine guarantees this, but narrow for the type checker.
      if (cfg.redis === undefined) {
        throw new Error("redis config is required when provider is 'redis'");
      }
      return new RedisMessageQueue(
        {
          url: cfg.redis.url,
          keyPrefix: cfg.redis.keyPrefix,
          blockMs: cfg.redis.blockMs,
          batchSize: cfg.redis.batchSize,
        },
        deps,
      );
    case "noop":
      return new NoopMessageQueue();
  }
}
