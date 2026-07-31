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
