import { z } from "zod";

/** In-process-broker config. No tuning; present for symmetry. */
export const MemoryMessageQueueConfigSchema = z.object({});
export type MemoryMessageQueueConfig = z.infer<typeof MemoryMessageQueueConfigSchema>;

/** Redis PUB/SUB config. Faithful to Go's `redis.Config`. */
export const RedisMessageQueueConfigSchema = z.object({
  /** One or more `host:port` addresses; more than one selects a cluster client. */
  queueAddresses: z.array(z.string()).min(1),
  username: z.string().optional(),
  password: z.string().optional(),
});
export type RedisMessageQueueConfig = z.infer<typeof RedisMessageQueueConfigSchema>;

/** Amazon SQS config. Faithful to Go's `sqs.Config` (topic = queue URL); AWS creds resolve ambiently. */
export const SQSMessageQueueConfigSchema = z.object({
  region: z.string().optional(),
  endpoint: z.string().url().optional(),
  credentials: z
    .object({
      accessKeyId: z.string(),
      secretAccessKey: z.string(),
      sessionToken: z.string().optional(),
    })
    .optional(),
});
export type SQSMessageQueueConfig = z.infer<typeof SQSMessageQueueConfigSchema>;

/** GCP Pub/Sub config. Faithful to Go's `pubsub.Config`. */
export const PubSubMessageQueueConfigSchema = z.object({
  projectId: z.string().min(1),
});
export type PubSubMessageQueueConfig = z.infer<typeof PubSubMessageQueueConfigSchema>;

/** Kafka config. Faithful to Go's `kafka.Config`. */
export const KafkaMessageQueueConfigSchema = z.object({
  brokers: z.array(z.string()).min(1),
  groupId: z.string().default(""),
});
export type KafkaMessageQueueConfig = z.infer<typeof KafkaMessageQueueConfigSchema>;

/** The set of message-queue providers. Mirrors Go's `provider` constants plus TS-only `memory`. */
export const MESSAGE_QUEUE_PROVIDERS = [
  "memory",
  "redis",
  "sqs",
  "pubsub",
  "kafka",
  "noop",
] as const;

/**
 * Selects and configures a provider for one role (publishing or consuming). Replaces the Go
 * `env:`-tagged `MessageQueueConfig` + ozzo `ValidateWithContext`. A process that publishes to one
 * backend and consumes from another simply builds each role from its own config — more flexible
 * than Go's fixed `Config{Consumer, Publisher}` wrapper, and the same switch under the hood.
 */
export const MessageQueueConfigSchema = z
  .object({
    provider: z.enum(MESSAGE_QUEUE_PROVIDERS).default("memory"),
    memory: MemoryMessageQueueConfigSchema.optional(),
    redis: RedisMessageQueueConfigSchema.optional(),
    sqs: SQSMessageQueueConfigSchema.optional(),
    pubsub: PubSubMessageQueueConfigSchema.optional(),
    kafka: KafkaMessageQueueConfigSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    const required: Record<string, unknown> = {
      redis: cfg.redis,
      pubsub: cfg.pubsub,
      kafka: cfg.kafka,
    };
    const missing = required[cfg.provider];
    if (cfg.provider in required && missing === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [cfg.provider],
        message: `${cfg.provider} config is required when provider is '${cfg.provider}'`,
      });
    }
  });

export type MessageQueueConfig = z.infer<typeof MessageQueueConfigSchema>;
export type MessageQueueConfigInput = z.input<typeof MessageQueueConfigSchema>;

/**
 * The platform's queue names. Faithful to Go's `QueuesConfig`; every name is required so a
 * misconfigured deployment fails fast rather than publishing to an empty topic.
 */
export const QueuesConfigSchema = z.object({
  dataChangesTopicName: z.string().min(1),
  outboundEmailsTopicName: z.string().min(1),
  searchIndexRequestsTopicName: z.string().min(1),
  mobileNotificationsTopicName: z.string().min(1),
  userDataAggregationTopicName: z.string().min(1),
  webhookExecutionRequestsTopicName: z.string().min(1),
});
export type QueuesConfig = z.infer<typeof QueuesConfigSchema>;
export type QueuesConfigInput = z.input<typeof QueuesConfigSchema>;
