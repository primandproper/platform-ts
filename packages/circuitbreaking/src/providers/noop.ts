import type { CircuitBreaker } from "../circuitbreaking.js";

/** Circuit breaker that never trips: every caller may proceed. */
export class NoopCircuitBreaker implements CircuitBreaker {
  canProceed(): boolean {
    return true;
  }

  succeeded(): void {}

  failed(): void {}
}
