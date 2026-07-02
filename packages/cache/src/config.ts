import { z } from "zod";

/** One hour, in milliseconds — the default expiry, mirroring the Go platform's `1h`. */
const DEFAULT_EXPIRY_MS = 3_600_000;

const BaseCacheConfigSchema = z.object({
  /** Per-entry time-to-live in milliseconds. `0` disables expiry. */
  expiryMs: z.number().int().nonnegative().default(DEFAULT_EXPIRY_MS),
});

export const RedisConfigSchema = z.object({
  url: z.string().url(),
  keyPrefix: z.string().default(""),
});

export type RedisConfig = z.infer<typeof RedisConfigSchema>;

/** Node cache config. Replaces the Go `env:`-tagged struct + ozzo `ValidateWithContext`. */
export const NodeCacheConfigSchema = BaseCacheConfigSchema.extend({
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

export type NodeCacheConfig = z.infer<typeof NodeCacheConfigSchema>;
export type NodeCacheConfigInput = z.input<typeof NodeCacheConfigSchema>;

/** Browser cache config. The web-storage provider is namespaced to avoid key collisions. */
export const BrowserCacheConfigSchema = BaseCacheConfigSchema.extend({
  provider: z.enum(["memory", "web", "noop"]).default("memory"),
  namespace: z.string().default("cache"),
});

export type BrowserCacheConfig = z.infer<typeof BrowserCacheConfigSchema>;
export type BrowserCacheConfigInput = z.input<typeof BrowserCacheConfigSchema>;
