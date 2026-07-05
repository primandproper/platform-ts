import { z } from "zod";

/** Universal retry config. Replaces the Go `env:`-tagged struct + ozzo validation. */
export const RetryConfigSchema = z.object({
  /** Total attempts, including the first. */
  maxAttempts: z.number().int().positive().default(3),
  /** Delay before the first retry, in milliseconds; doubles each subsequent retry. */
  baseDelayMs: z.number().int().nonnegative().default(100),
  /** Upper bound on any single delay, in milliseconds. */
  maxDelayMs: z.number().int().nonnegative().default(30_000),
  /** Fraction of each delay (0..1) randomized to avoid thundering herds. */
  jitter: z.number().min(0).max(1).default(0.1),
  /**
   * Total-elapsed budget across all attempts, in milliseconds; `0` disables it. When set, the
   * policy gives up (rather than sleeping past the budget) once the next backoff would exceed
   * it, so a slow-failing operation can't retry unboundedly in wall-clock terms.
   */
  maxElapsedMs: z.number().int().nonnegative().default(0),
});

export type RetryConfig = z.infer<typeof RetryConfigSchema>;
export type RetryConfigInput = z.input<typeof RetryConfigSchema>;
