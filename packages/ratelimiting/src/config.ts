import { z } from "zod";

/** Default ceiling: 100 requests per window, mirroring the Go platform's defaults. */
const DEFAULT_LIMIT = 100;
/** One minute, in milliseconds — the default window. */
const DEFAULT_WINDOW_MS = 60_000;

const BaseRateLimitConfigSchema = z.object({
  /** Maximum cost permitted within a single window. */
  limit: z.number().int().positive().default(DEFAULT_LIMIT),
  /** Window length in milliseconds, after which capacity is restored. */
  windowMs: z.number().int().positive().default(DEFAULT_WINDOW_MS),
});

export const RedisConfigSchema = z.object({
  url: z.string().url(),
  keyPrefix: z.string().default(""),
  /** Reject a command that outlives this many ms — the fail-fast timeout knob. Off by default. */
  commandTimeoutMs: z.number().int().positive().optional(),
  /** TCP connect timeout in ms. Defaults to ioredis's 10s. */
  connectTimeoutMs: z.number().int().positive().optional(),
  /**
   * Behaviour when Redis is unreachable. `false` (default) fails closed — deny while Redis is down,
   * so an outage can't lift the limit. `true` fails open — keep admitting, trading the guarantee for
   * availability. See {@link RedisRateLimiterOptions.failOpen}.
   */
  failOpen: z.boolean().default(false),
});

export type RedisConfig = z.infer<typeof RedisConfigSchema>;

/** Node config. Replaces the Go `env:`-tagged struct + ozzo `ValidateWithContext`. */
export const NodeRateLimitConfigSchema = BaseRateLimitConfigSchema.extend({
  /**
   * Which limiter backend to use. NOTE: the default, `memory`, keeps counters **per process**. In a
   * multi-instance deployment (multiple replicas / workers behind a load balancer) each instance
   * then enforces the limit independently, so the effective ceiling is roughly `limit × instances`
   * rather than `limit`. Use `redis` for a shared, cluster-wide limit; `memory` is intended for
   * single-instance services, local development, and tests.
   */
  provider: z.enum(["memory", "redis", "noop"]).default("memory"),
  redis: RedisConfigSchema.optional(),
}).superRefine((cfg, ctx) => {
  if (cfg.provider === "redis" && cfg.redis === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["redis"],
      message: "redis config is required when provider is 'redis'",
    });
  }
});

export type NodeRateLimitConfig = z.infer<typeof NodeRateLimitConfigSchema>;
export type NodeRateLimitConfigInput = z.input<typeof NodeRateLimitConfigSchema>;

/** Browser config. No redis provider — only memory and noop run in the browser. */
export const BrowserRateLimitConfigSchema = BaseRateLimitConfigSchema.extend({
  provider: z.enum(["memory", "noop"]).default("memory"),
});

export type BrowserRateLimitConfig = z.infer<typeof BrowserRateLimitConfigSchema>;
export type BrowserRateLimitConfigInput = z.input<typeof BrowserRateLimitConfigSchema>;
