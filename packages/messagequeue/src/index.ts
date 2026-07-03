import type { ObservabilityDeps } from "@primandproper/observability";

import { MessageQueueConfigSchema, type MessageQueueConfigInput } from "./config.js";
import type { ConsumerProvider, PublisherProvider } from "./messagequeue.js";
import { KafkaConsumerProvider, KafkaPublisherProvider } from "./providers/kafka.node.js";
import {
  provideMemoryConsumerProvider,
  provideMemoryPublisherProvider,
} from "./providers/memory.js";
import { NoopConsumerProvider, NoopPublisherProvider } from "./providers/noop.js";
import {
  PubSubConsumerProvider,
  PubSubPublisherProvider,
} from "./providers/pubsub.node.js";
import { RedisConsumerProvider, RedisPublisherProvider } from "./providers/redis.node.js";
import { SQSConsumerProvider, SQSPublisherProvider } from "./providers/sqs.node.js";

export * from "./messagequeue.js";
export * from "./config.js";

export { MemoryBroker } from "./providers/memory.js";
export {
  provideMemoryConsumerProvider,
  provideMemoryPublisherProvider,
  MemoryConsumerProvider,
  MemoryPublisherProvider,
} from "./providers/memory.js";
export {
  NoopConsumerProvider,
  NoopPublisherProvider,
  NoopConsumer,
  NoopPublisher,
} from "./providers/noop.js";
export {
  RedisConsumerProvider,
  RedisPublisherProvider,
  type RedisMessageQueueOptions,
} from "./providers/redis.node.js";
export {
  SQSConsumerProvider,
  SQSPublisherProvider,
  type SQSMessageQueueOptions,
} from "./providers/sqs.node.js";
export {
  PubSubConsumerProvider,
  PubSubPublisherProvider,
  type PubSubMessageQueueOptions,
} from "./providers/pubsub.node.js";
export {
  KafkaConsumerProvider,
  KafkaPublisherProvider,
  type KafkaMessageQueueOptions,
} from "./providers/kafka.node.js";

/**
 * Validates config and returns the matching {@link PublisherProvider}. Mirrors Go's
 * `ProvidePublisherProvider`. `memory` (default) and `noop` need no further config; `redis`,
 * `pubsub`, and `kafka` require their config block (enforced by the schema); `sqs` resolves AWS
 * credentials ambiently unless overridden.
 */
export function providePublisherProvider(
  config?: MessageQueueConfigInput,
  deps?: ObservabilityDeps,
): PublisherProvider {
  const cfg = MessageQueueConfigSchema.parse(config ?? {});
  switch (cfg.provider) {
    case "memory":
      return provideMemoryPublisherProvider(deps);
    case "redis":
      return new RedisPublisherProvider(required(cfg.redis, "redis"), deps);
    case "sqs":
      return new SQSPublisherProvider(cfg.sqs ?? {}, deps);
    case "pubsub":
      return new PubSubPublisherProvider(required(cfg.pubsub, "pubsub"), deps);
    case "kafka":
      return new KafkaPublisherProvider(required(cfg.kafka, "kafka"), deps);
    case "noop":
      return new NoopPublisherProvider();
  }
}

/**
 * Validates config and returns the matching {@link ConsumerProvider}. Mirrors Go's
 * `ProvideConsumerProvider`. See {@link providePublisherProvider} for per-provider config rules.
 */
export function provideConsumerProvider(
  config?: MessageQueueConfigInput,
  deps?: ObservabilityDeps,
): ConsumerProvider {
  const cfg = MessageQueueConfigSchema.parse(config ?? {});
  switch (cfg.provider) {
    case "memory":
      return provideMemoryConsumerProvider(deps);
    case "redis":
      return new RedisConsumerProvider(required(cfg.redis, "redis"), deps);
    case "sqs":
      return new SQSConsumerProvider(cfg.sqs ?? {}, deps);
    case "pubsub":
      return new PubSubConsumerProvider(required(cfg.pubsub, "pubsub"), deps);
    case "kafka":
      return new KafkaConsumerProvider(required(cfg.kafka, "kafka"), deps);
    case "noop":
      return new NoopConsumerProvider();
  }
}

/**
 * Narrows a per-provider config the schema's `superRefine` has already guaranteed present, so the
 * type checker sees a defined value without a non-null assertion.
 */
function required<T>(value: T | undefined, provider: string): T {
  if (value === undefined) {
    throw new Error(`${provider} config is required when provider is '${provider}'`);
  }
  return value;
}
