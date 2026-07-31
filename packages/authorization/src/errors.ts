import { isPlatformError, PlatformError } from "@primandproper/errors";

/** The `code` every {@link PermissionDeniedError} carries. */
export const PERMISSION_DENIED_CODE = "authorization/permission-denied";

/** The `code` prefix shared by every malformed-policy error. */
export const POLICY_INVALID_CODE = "authorization/policy-invalid";

/**
 * The requester lacks the authority to perform the action.
 *
 * The message a client sees is the constant `"permission denied"`. Which permission was missing
 * goes to `missing`, and from there to the span and the log, and stops there — naming it in a
 * response discloses the permission taxonomy to a caller who just failed to authorize. Anything
 * that serializes this error to a client should send `message` and nothing else.
 */
export class PermissionDeniedError extends PlatformError {
  /** The permissions the principal did not hold. Diagnostic only — never put this in a response body. */
  readonly missing: readonly string[];

  constructor(missing: readonly string[] = [], options?: ErrorOptions) {
    super(PERMISSION_DENIED_CODE, "permission denied", options);
    this.name = "PermissionDeniedError";
    this.missing = [...missing];
  }
}

/** True when `err` is a {@link PermissionDeniedError}, including one wrapped by `@primandproper/errors`. */
export function isPermissionDenied(err: unknown): boolean {
  return isPlatformError(err, PERMISSION_DENIED_CODE);
}

/** Why a policy was rejected. Each value is also the suffix of the thrown error's `code`. */
export type PolicyProblem =
  | "empty-role-name"
  | "duplicate-role"
  | "unknown-parent-role"
  | "self-inheritance"
  | "inheritance-cycle";

/**
 * A policy is malformed and was rejected rather than partially applied.
 *
 * Both the validator and every resolver throw this, so a policy rejected in one backend is
 * rejected in the others — a code-side policy cannot quietly drift from a stored one.
 */
export class InvalidPolicyError extends PlatformError {
  /** Which rule the policy broke, for callers that branch rather than just report. */
  readonly problem: PolicyProblem;

  constructor(problem: PolicyProblem, message: string, options?: ErrorOptions) {
    super(`${POLICY_INVALID_CODE}/${problem}`, message, options);
    this.name = "InvalidPolicyError";
    this.problem = problem;
  }
}

/** True when `err` is an {@link InvalidPolicyError}; narrows to a specific `problem` when given. */
export function isInvalidPolicy(err: unknown, problem?: PolicyProblem): boolean {
  if (!isPlatformError(err)) {
    return false;
  }
  return problem === undefined
    ? err.code.startsWith(`${POLICY_INVALID_CODE}/`)
    : err.code === `${POLICY_INVALID_CODE}/${problem}`;
}

/** The `code` every {@link InvalidRequirementsError} carries. */
export const REQUIREMENTS_INVALID_CODE = "authorization/requirements-invalid";

/** Why a single declaration in a requirements table was rejected. */
export interface RequirementProblem {
  /** Which rule the declaration broke. */
  kind: "empty-key" | "duplicate-key" | "no-permissions-required" | "empty-permission";
  /** The route or method key the problem belongs to. Empty for an `empty-key` problem. */
  key: string;
  /** A sentence naming the problem, suitable for a startup log. */
  message: string;
}

/**
 * A requirements table was rejected rather than built.
 *
 * It carries **every** problem the builder found rather than the first. A table assembled from a
 * dozen feature modules usually has more than one, and fixing them a restart at a time is
 * miserable.
 */
export class InvalidRequirementsError extends PlatformError {
  /** Every problem found, in the order the builder reports them (declaration order, then key order). */
  readonly problems: readonly RequirementProblem[];

  constructor(problems: readonly RequirementProblem[], options?: ErrorOptions) {
    super(
      REQUIREMENTS_INVALID_CODE,
      `invalid authorization requirements: ${problems.map((p) => p.message).join("; ")}`,
      options,
    );
    this.name = "InvalidRequirementsError";
    this.problems = [...problems];
  }
}

/** True when `err` is an {@link InvalidRequirementsError}. */
export function isInvalidRequirements(err: unknown): boolean {
  return isPlatformError(err, REQUIREMENTS_INVALID_CODE);
}

/** The `code` every {@link RouteCoverageError} carries. */
export const ROUTE_COVERAGE_CODE = "authorization/route-coverage";

/**
 * A server registered routes its requirements table does not account for.
 *
 * This is the failure the boot-time check exists to produce, and it is deliberately a startup
 * crash rather than a runtime denial: a route nobody declared is a route nobody decided about,
 * and finding that out on deploy is far cheaper than finding it out from a caller.
 */
export class RouteCoverageError extends PlatformError {
  /** Routes the server registered that the table neither requires permissions for nor marks public. */
  readonly undeclared: readonly string[];
  /** Keys the table declares that the server never registered — usually a rename that lost its declaration. */
  readonly stale: readonly string[];

  constructor(
    undeclared: readonly string[],
    stale: readonly string[],
    options?: ErrorOptions,
  ) {
    super(ROUTE_COVERAGE_CODE, coverageMessage(undeclared, stale), options);
    this.name = "RouteCoverageError";
    this.undeclared = [...undeclared];
    this.stale = [...stale];
  }
}

/** True when `err` is a {@link RouteCoverageError}. */
export function isRouteCoverage(err: unknown): boolean {
  return isPlatformError(err, ROUTE_COVERAGE_CODE);
}

function coverageMessage(
  undeclared: readonly string[],
  stale: readonly string[],
): string {
  const parts: string[] = [];
  if (undeclared.length > 0) {
    parts.push(`undeclared routes: ${undeclared.join(", ")}`);
  }
  if (stale.length > 0) {
    parts.push(`declared but never registered: ${stale.join(", ")}`);
  }
  return `authorization route coverage: ${parts.join("; ")}`;
}
