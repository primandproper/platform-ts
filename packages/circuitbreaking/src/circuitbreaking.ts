/**
 * A circuit breaker guards a downstream dependency from a flood of doomed calls.
 *
 * It moves through three states:
 *
 * - **closed** — the normal state; calls flow through. Each {@link CircuitBreaker.failed}
 *   advances toward the failure threshold; a {@link CircuitBreaker.succeeded} resets it.
 * - **open** — reached after `failureThreshold` consecutive failures. Calls are rejected
 *   ({@link CircuitBreaker.canProceed} returns `false`) for the cooldown window.
 * - **half-open** — entered once `openDurationMs` has elapsed since opening. A limited number
 *   of probe calls are allowed through; a {@link CircuitBreaker.succeeded} closes the circuit,
 *   while a {@link CircuitBreaker.failed} re-opens it for another cooldown window.
 *
 * The analogue of the Go platform's `CircuitBreaker` interface.
 */
export interface CircuitBreaker {
  /** Whether the caller may proceed (closed or half-open) rather than being rejected (open). */
  canProceed(): boolean;
  /** Reports a successful call, closing a half-open circuit and resetting failure counts. */
  succeeded(): void;
  /** Reports a failed call, tripping the circuit once the failure threshold is reached. */
  failed(): void;
}
