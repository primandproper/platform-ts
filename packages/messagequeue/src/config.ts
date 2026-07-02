import { z } from "zod";

/** In-memory-provider config. No tuning yet; present for symmetry and future options. */
export const MemoryMessageQueueConfigSchema = z.object({});

export type MemoryMessageQueueConfig = z.infer<typeof MemoryMessageQueueConfigSchema>;

/** Redis-Streams-provider config: a single-node Redis reached via ioredis. */
export const RedisMessageQueueConfigSchema = z.object({
  url: z.string().url(),
  keyPrefix: z.string().default(""),
  /** How long each blocking read parks waiting for new messages, in milliseconds. */
  blockMs: z.number().int().positive().default(5_000),
  /** Maximum number of messages pulled per read. */
  batchSize: z.number().int().positive().default(16),
});

export type RedisMessageQueueConfig = z.infer<typeof RedisMessageQueueConfigSchema>;

/**
 * Message-queue config. Replaces the Go `env:`-tagged struct + ozzo `ValidateWithContext`.
 * `memory` (default) is a real in-process pub/sub; `noop` drops everything; `redis` (Redis
 * Streams, one consumer group per subscriber) gives durable cross-process fan-out and stays
 * server-side.
 *
 * Google Pub/Sub, AWS SQS, and Kafka are intended future providers — each needs its own SDK
 * and stays server-side, so they are deliberately not implemented here.
 */
export const MessageQueueConfigSchema = z
  .object({
    provider: z.enum(["memory", "redis", "noop"]).default("memory"),
    memory: MemoryMessageQueueConfigSchema.optional(),
    redis: RedisMessageQueueConfigSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.provider === "redis" && cfg.redis === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["redis"],
        message: "redis config is required when provider is 'redis'",
      });
    }
  });

export type MessageQueueConfig = z.infer<typeof MessageQueueConfigSchema>;
export type MessageQueueConfigInput = z.input<typeof MessageQueueConfigSchema>;
