import {
  makeMetrics,
  type Metrics,
  type ObservabilityDeps,
} from "@primandproper/observability";

type Counter = ReturnType<Metrics["counter"]>;

/**
 * What a manager reports. Idempotency is a control that fails silently when it fails at all, so
 * the instruments are the only way to learn it has stopped working.
 *
 * `claimsLost` is the one to alert on: it is the only remaining path to a duplicate effect, and
 * it always means the same thing — `inFlightTtlMs` is too short for the work it guards.
 *
 * There is no latency instrument here on purpose: `Observer.run` already records
 * `operation.duration{operation="run"}` for every call, and a second histogram over the same
 * span would be the same number under two names.
 */
export interface IdempotencyInstruments {
  /** Every resolved call, tagged `outcome` (`executed`/`replayed`/`in_flight`/`mismatch`). */
  requests: Counter;
  /** Work outran its claim and the key was taken by someone else. The alert. */
  claimsLost: Counter;
  /** The effect happened, the record did not land, and a retry will run the work again. */
  recordFailures: Counter;
  /** Store health: a read or write the record store refused. */
  storeErrors: Counter;
  /** Records ignored for carrying another version — expect one spike after a shape change. */
  staleRecords: Counter;
}

/** Builds the manager's instruments, defaulting to the noop meter. */
export function idempotencyInstruments(
  o11yName: string,
  deps: ObservabilityDeps | undefined,
): IdempotencyInstruments {
  const metrics = makeMetrics(o11yName, deps?.metrics);
  return {
    requests: metrics.counter("idempotency.requests", {
      description:
        "Count of resolved idempotent calls, tagged by outcome (executed/replayed/in_flight/mismatch).",
    }),
    claimsLost: metrics.counter("idempotency.claims.lost", {
      description:
        "Count of executions whose claim was taken by someone else before they could complete it.",
    }),
    recordFailures: metrics.counter("idempotency.record.failures", {
      description:
        "Count of completed executions whose result could not be recorded, so a retry will re-run the work.",
    }),
    storeErrors: metrics.counter("idempotency.store.errors", {
      description: "Count of record-store reads or writes that failed.",
    }),
    staleRecords: metrics.counter("idempotency.stale.records", {
      description:
        "Count of stored records ignored for carrying a different record version.",
    }),
  };
}
