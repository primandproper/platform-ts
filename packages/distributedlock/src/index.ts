import type { QueryablePool } from "@primandproper/database";
import type { ObservabilityDeps } from "@primandproper/observability";

import {
  DistributedLockConfigSchema,
  type DistributedLockConfigInput,
} from "./config.js";
import type { DistributedLock } from "./distributedlock.js";
import {
  MemoryDistributedLock,
  type MemoryDistributedLockDeps,
} from "./providers/memory.js";
import { NoopDistributedLock } from "./providers/noop.js";
import { PostgresDistributedLock } from "./providers/postgres.node.js";
import { RedisDistributedLock } from "./providers/redis.node.js";

export * from "./distributedlock.js";
export * from "./config.js";
export {
  MemoryDistributedLock,
  type MemoryDistributedLockDeps,
  type MemoryDistributedLockOptions,
} from "./providers/memory.js";
export { NoopDistributedLock } from "./providers/noop.js";
export {
  PostgresDistributedLock,
  type PostgresDistributedLockOptions,
} from "./providers/postgres.node.js";
export {
  RedisDistributedLock,
  type RedisDistributedLockOptions,
} from "./providers/redis.node.js";

/**
 * Deps accepted by {@link provideDistributedLock}: observability, an injectable clock, and — for the
 * `postgres` provider — the database pool the lease table lives in.
 */
export interface DistributedLockDeps extends ObservabilityDeps {
  now?: () => number;
  /** Required when `provider` is `postgres`: the pool the lock table is read/written through. */
  pool?: QueryablePool;
}

/**
 * Validates config (applying defaults) and returns the matching {@link DistributedLock}.
 * Mirrors the Go platform's `ProvideDistributedLock`. Supports `memory` (default), `redis`,
 * and `noop`.
 */
export function provideDistributedLock(
  config?: DistributedLockConfigInput,
  deps?: DistributedLockDeps,
): DistributedLock {
  const cfg = DistributedLockConfigSchema.parse(config ?? {});
  const memoryDeps: MemoryDistributedLockDeps = {};
  if (deps?.logger !== undefined) {
    memoryDeps.logger = deps.logger;
  }
  if (deps?.tracer !== undefined) {
    memoryDeps.tracer = deps.tracer;
  }
  if (deps?.metrics !== undefined) {
    memoryDeps.metrics = deps.metrics;
  }
  if (deps?.observer !== undefined) {
    memoryDeps.observer = deps.observer;
  }
  if (deps?.now !== undefined) {
    memoryDeps.now = deps.now;
  }

  switch (cfg.provider) {
    case "memory":
      return new MemoryDistributedLock(
        cfg.memory ? { defaultTtlMs: cfg.memory.defaultTtlMs } : {},
        memoryDeps,
      );
    case "redis":
      // superRefine guarantees this, but narrow for the type checker.
      if (cfg.redis === undefined) {
        throw new Error("redis config is required when provider is 'redis'");
      }
      return new RedisDistributedLock(
        {
          url: cfg.redis.url,
          keyPrefix: cfg.redis.keyPrefix,
          defaultTtlMs: cfg.redis.defaultTtlMs,
          ...(cfg.redis.commandTimeoutMs !== undefined
            ? { commandTimeoutMs: cfg.redis.commandTimeoutMs }
            : {}),
          ...(cfg.redis.connectTimeoutMs !== undefined
            ? { connectTimeoutMs: cfg.redis.connectTimeoutMs }
            : {}),
        },
        memoryDeps,
      );
    case "postgres": {
      if (deps?.pool === undefined) {
        throw new Error("a `pool` dep is required when provider is 'postgres'");
      }
      const pg = cfg.postgres;
      return new PostgresDistributedLock(
        {
          pool: deps.pool,
          ...(pg?.table !== undefined ? { table: pg.table } : {}),
          ...(pg?.defaultTtlMs !== undefined ? { defaultTtlMs: pg.defaultTtlMs } : {}),
        },
        memoryDeps,
      );
    }
    case "noop":
      return new NoopDistributedLock();
  }
}
