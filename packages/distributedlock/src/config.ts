import { z } from "zod";

/** Memory-provider config: an in-process lock manager scoped to one Node process. */
export const MemoryDistributedLockConfigSchema = z.object({
  /** Default lease duration when {@link AcquireOptions.ttlMs} is omitted, in milliseconds. */
  defaultTtlMs: z.number().int().positive().default(30_000),
});

export type MemoryDistributedLockConfig = z.infer<
  typeof MemoryDistributedLockConfigSchema
>;

/** Redis-provider config: a single-node Redis reached via ioredis. */
export const RedisDistributedLockConfigSchema = z.object({
  url: z.string().url(),
  keyPrefix: z.string().default(""),
  /** Default lease duration when {@link AcquireOptions.ttlMs} is omitted, in milliseconds. */
  defaultTtlMs: z.number().int().positive().default(30_000),
  /** Reject a command that outlives this many ms — the fail-fast timeout knob. Off by default. */
  commandTimeoutMs: z.number().int().positive().optional(),
  /** TCP connect timeout in ms. Defaults to ioredis's 10s. */
  connectTimeoutMs: z.number().int().positive().optional(),
});

export type RedisDistributedLockConfig = z.infer<typeof RedisDistributedLockConfigSchema>;

/**
 * Postgres-provider config: a lease table reached via a `@primandproper/database` pool (supplied at
 * provide-time through {@link DistributedLockDeps.pool}, since a pool is a runtime value, not config).
 */
export const PostgresDistributedLockConfigSchema = z.object({
  /** The lease table name (a plain identifier). */
  table: z.string().default("distributed_locks"),
  /** Default lease duration when {@link AcquireOptions.ttlMs} is omitted, in milliseconds. */
  defaultTtlMs: z.number().int().positive().default(30_000),
});

export type PostgresDistributedLockConfig = z.infer<
  typeof PostgresDistributedLockConfigSchema
>;

/**
 * Distributed-lock config. Replaces the Go `env:`-tagged struct + ozzo `ValidateWithContext`.
 * `memory` is a correct single-process lock; `noop` always grants and never blocks; `redis`
 * (single-node `SET NX PX` + compare-and-delete) and `postgres` (a token+expiry lease table) give
 * cross-process exclusion and stay server-side. The `postgres` provider also needs a DB pool passed
 * via {@link DistributedLockDeps.pool}.
 */
export const DistributedLockConfigSchema = z
  .object({
    provider: z.enum(["memory", "redis", "postgres", "noop"]).default("memory"),
    memory: MemoryDistributedLockConfigSchema.optional(),
    redis: RedisDistributedLockConfigSchema.optional(),
    postgres: PostgresDistributedLockConfigSchema.optional(),
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

export type DistributedLockConfig = z.infer<typeof DistributedLockConfigSchema>;
export type DistributedLockConfigInput = z.input<typeof DistributedLockConfigSchema>;
