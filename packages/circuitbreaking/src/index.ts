import type { CircuitBreaker } from "./circuitbreaking.js";
import { CircuitBreakerConfigSchema, type CircuitBreakerConfigInput } from "./config.js";
import { NoopCircuitBreaker } from "./providers/noop.js";
import {
  PartitionedCircuitBreaker,
  type PartitionedDeps,
} from "./providers/partitioned.js";

export * from "./circuitbreaking.js";
export * from "./config.js";
export * from "./providers/noop.js";
export * from "./providers/partitioned.js";

/**
 * Validates config (applying defaults) and returns the matching circuit breaker. Mirrors the
 * Go platform's `ProvideCircuitBreaker`. Supports `partitioned` (default) and `noop`.
 */
export function provideCircuitBreaker(
  config?: CircuitBreakerConfigInput,
  deps?: PartitionedDeps,
): CircuitBreaker {
  const cfg = CircuitBreakerConfigSchema.parse(config ?? {});
  switch (cfg.provider) {
    case "partitioned":
      return new PartitionedCircuitBreaker(cfg, deps);
    case "noop":
      return new NoopCircuitBreaker();
  }
}
