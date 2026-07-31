import { isPlatformError, wrap } from "@primandproper/errors";
import { describe, expect, it } from "vitest";

import {
  InvalidPolicyError,
  isInvalidPolicy,
  isPermissionDenied,
  PermissionDeniedError,
  PERMISSION_DENIED_CODE,
  POLICY_INVALID_CODE,
} from "./errors.js";

describe("PermissionDeniedError", () => {
  it("says only 'permission denied', whatever was missing", () => {
    // Naming the permission in a response discloses the taxonomy to a caller who just failed to
    // authorize, so the message is a constant and the detail rides alongside.
    const err = new PermissionDeniedError(["billing.refund"]);
    expect(err.message).toBe("permission denied");
    expect(err.message).not.toContain("billing.refund");
    expect(err.missing).toEqual(["billing.refund"]);
  });

  it("carries the shared code and is recognised by the guard", () => {
    const err = new PermissionDeniedError();
    expect(err.code).toBe(PERMISSION_DENIED_CODE);
    expect(isPermissionDenied(err)).toBe(true);
    expect(isPlatformError(err, PERMISSION_DENIED_CODE)).toBe(true);
  });

  it("defaults to no missing permissions and copies the list it is given", () => {
    expect(new PermissionDeniedError().missing).toEqual([]);

    const missing = ["a"];
    const err = new PermissionDeniedError(missing);
    missing.push("b");
    expect(err.missing).toEqual(["a"]);
  });

  it("is still recognised once wrapped for context", () => {
    // `wrap` re-raises a PlatformError under the same code, so adding context at a boundary does
    // not turn a denial into a 500. The `missing` list does not survive the wrap — it lives on
    // the original, reachable through `cause`.
    const original = new PermissionDeniedError(["users.delete"]);
    const wrapped = wrap("deleting user", original);

    expect(isPermissionDenied(wrapped)).toBe(true);
    expect(wrapped.message).toBe("deleting user: permission denied");
    expect(wrapped).not.toBeInstanceOf(PermissionDeniedError);
    expect((wrapped.cause as PermissionDeniedError).missing).toEqual(["users.delete"]);
  });

  it("keeps a cause when given one", () => {
    const cause = new Error("upstream");
    expect(new PermissionDeniedError([], { cause }).cause).toBe(cause);
  });

  it("is not confused for a policy error", () => {
    expect(isInvalidPolicy(new PermissionDeniedError())).toBe(false);
  });
});

describe("InvalidPolicyError", () => {
  it("codes the specific problem under the shared prefix", () => {
    const err = new InvalidPolicyError("duplicate-role", "duplicate role name: reader");
    expect(err.code).toBe(`${POLICY_INVALID_CODE}/duplicate-role`);
    expect(err.problem).toBe("duplicate-role");
    expect(err.message).toBe("duplicate role name: reader");
  });

  it("is matched by the guard, with or without a specific problem", () => {
    const err = new InvalidPolicyError("inheritance-cycle", "a -> b -> a");
    expect(isInvalidPolicy(err)).toBe(true);
    expect(isInvalidPolicy(err, "inheritance-cycle")).toBe(true);
    expect(isInvalidPolicy(err, "duplicate-role")).toBe(false);
  });

  it("does not match a non-platform error or an unrelated one", () => {
    expect(isInvalidPolicy(new Error("nope"))).toBe(false);
    expect(isInvalidPolicy(undefined)).toBe(false);
    expect(isPermissionDenied(new InvalidPolicyError("empty-role-name", "x"))).toBe(
      false,
    );
  });
});
