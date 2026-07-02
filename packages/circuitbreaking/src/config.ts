import { z } from "zod";

/** Universal circuit-breaker config. Replaces the Go `env:`-tagged struct + ozzo validation. */
export const CircuitBreakerConfigSchema = z.object({
  /** Which implementation to build. */
  provider: z.enum(["partitioned", "noop"]).default("partitioned"),
  /** Consecutive failures that trip a closed circuit open. */
  failureThreshold: z.number().int().positive().default(5),
  /** How long a circuit stays open before allowing half-open probe calls, in milliseconds. */
  openDurationMs: z.number().int().positive().default(30_000),
  /** Probe calls permitted while half-open before the circuit is forced back open. */
  halfOpenMaxAttempts: z.number().int().positive().default(1),
});

export type CircuitBreakerConfig = z.infer<typeof CircuitBreakerConfigSchema>;
export type CircuitBreakerConfigInput = z.input<typeof CircuitBreakerConfigSchema>;
