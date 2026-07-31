import {
  makeMetrics,
  type Metrics,
  type ObservabilityDeps,
} from "@primandproper/observability";

type Counter = ReturnType<Metrics["counter"]>;

/**
 * What an {@link import("./enforcement.js").Enforcer} reports.
 *
 * Three of the four count wiring bugs rather than misbehaving callers, and those are the ones to
 * alert on: `undeclared`, `emptyRequirements`, and `missingGrants` all mean the service is
 * enforcing something other than what its author intended. `denials` alone is ordinary traffic —
 * a caller reaching for something it may not have.
 *
 * Every instrument carries a `key` attribute when enforcement was table-driven, because one
 * enforcer serves every route and a single mis-declared one is invisible in the total. The key is
 * a declared route pattern, so its cardinality is bounded by the table; a raw URL path is not, and
 * is never used as a label here.
 */
export interface EnforcementInstruments {
  /** Every decision the enforcer made, allowed or not. The denominator. */
  checks: Counter;
  /** Decisions that came out `false`, whether or not audit-only let the request through. */
  denials: Counter;
  /** Requests reaching a guarded route with no determinable authority — usually authentication did not run, or ran after this. */
  missingGrants: Counter;
  /** Requests for a key the requirements table does not declare. The table is incomplete. */
  undeclared: Counter;
  /** Guarded routes whose requirement list was empty — the vacuous-allow hazard, denied and counted. */
  emptyRequirements: Counter;
}

/** Builds the enforcer's instruments, defaulting to the noop meter. */
export function enforcementInstruments(
  o11yName: string,
  deps: ObservabilityDeps | undefined,
): EnforcementInstruments {
  const metrics = makeMetrics(o11yName, deps?.metrics);
  return {
    checks: metrics.counter("authorization.checks", {
      description: "Count of authorization decisions made, allowed or denied.",
    }),
    denials: metrics.counter("authorization.denials", {
      description:
        "Count of authorization decisions that came out denied, including ones audit-only mode let through.",
    }),
    missingGrants: metrics.counter("authorization.missing_grants", {
      description:
        "Count of requests reaching a guarded route with no determinable authority.",
    }),
    undeclared: metrics.counter("authorization.undeclared", {
      description:
        "Count of requests for a key absent from the requirements table, which are denied.",
    }),
    emptyRequirements: metrics.counter("authorization.empty_requirements", {
      description:
        "Count of guarded routes whose required-permission list was empty, which are denied.",
    }),
  };
}
