import { describe, expect, it } from "vitest";

import {
  InvalidRequirementsError,
  isInvalidRequirements,
  isRouteCoverage,
  RouteCoverageError,
} from "./errors.js";
import { assertRoutesDeclared, newRequirements } from "./requirements.js";

/** Builds and returns the error a builder threw, failing the test if it built cleanly. */
function buildError(build: () => unknown): InvalidRequirementsError {
  try {
    build();
  } catch (err) {
    expect(isInvalidRequirements(err)).toBe(true);
    return err as InvalidRequirementsError;
  }
  return expect.unreachable("expected build to throw");
}

describe("RequirementsBuilder", () => {
  it("freezes what each key demands", () => {
    const reqs = newRequirements()
      .require("GET /recipes/:id", "recipes.read")
      .require("POST /recipes", "recipes.create", "recipes.read")
      .markPublic("GET /healthz")
      .build();

    expect(reqs.lookup("GET /recipes/:id")).toEqual({
      kind: "permissions",
      permissions: ["recipes.read"],
    });
    expect(reqs.lookup("POST /recipes")).toEqual({
      kind: "permissions",
      permissions: ["recipes.create", "recipes.read"],
    });
    expect(reqs.lookup("GET /healthz")).toEqual({ kind: "public" });
    expect(reqs.size).toBe(3);
  });

  it("reports an undeclared key as undeclared rather than as requiring nothing", () => {
    // The fail-closed path: enforcement must be able to tell "nothing required" from "never
    // decided about", and only the second one is a denial.
    const reqs = newRequirements().markPublic("GET /healthz").build();
    expect(reqs.lookup("GET /admin")).toBeUndefined();
  });

  it("refuses to build a key required with no permissions", () => {
    // Vacuous truth would make this authorize everyone while reading like a restriction. Saying
    // "needs nothing" is markPublic's job, and it looks like what it does.
    const err = buildError(() => newRequirements().require("GET /things").build());

    expect(err.problems).toHaveLength(1);
    expect(err.problems[0]?.kind).toBe("no-permissions-required");
    expect(err.problems[0]?.key).toBe("GET /things");
  });

  it("reports every problem rather than the first", () => {
    // A table assembled from a dozen feature modules usually has more than one, and fixing them a
    // restart at a time is miserable.
    const err = buildError(() =>
      newRequirements()
        .require("GET /a")
        .require("GET /b", "")
        .require("", "things.read")
        .markPublic("GET /c")
        .require("GET /c", "things.read")
        .build(),
    );

    expect(err.problems.map((p) => p.kind).sort()).toEqual([
      "duplicate-key",
      "empty-key",
      "empty-permission",
      "no-permissions-required",
    ]);
    expect(err.message).toContain("GET /a");
  });

  it("reports a key declared twice rather than letting one silently win", () => {
    const err = buildError(() =>
      newRequirements()
        .require("GET /things", "things.read")
        .require("GET /things", "things.admin")
        .build(),
    );

    expect(err.problems.map((p) => p.kind)).toEqual(["duplicate-key"]);
  });

  it("counts a key declared public twice as a duplicate too", () => {
    const err = buildError(() =>
      newRequirements().markPublic("GET /healthz").markPublic("GET /healthz").build(),
    );

    expect(err.problems.map((p) => p.kind)).toEqual(["duplicate-key"]);
  });

  it("rejects an empty permission in a declaration", () => {
    const err = buildError(() => newRequirements().require("GET /things", "").build());
    expect(err.problems.map((p) => p.kind)).toContain("empty-permission");
  });

  it("merges records, which is the shape a feature module exports", () => {
    const recipes = { "GET /recipes/:id": ["recipes.read"] };
    const billing = { "POST /refunds": ["billing.refund"] };

    const reqs = newRequirements().requireEach(recipes).requireEach(billing).build();

    expect(reqs.keys()).toEqual(["GET /recipes/:id", "POST /refunds"]);
  });

  it("reports a key two records both declare", () => {
    const err = buildError(() =>
      newRequirements()
        .requireEach({ "GET /things": ["things.read"] })
        .requireEach({ "GET /things": ["things.admin"] })
        .build(),
    );

    expect(err.problems.map((p) => p.kind)).toEqual(["duplicate-key"]);
  });

  it("copies a permission list in, so a later mutation cannot edit the requirement", () => {
    const permissions = ["things.read"];
    const reqs = newRequirements()
      .require("GET /things", ...permissions)
      .build();

    permissions.push("things.admin");

    expect(reqs.lookup("GET /things")).toEqual({
      kind: "permissions",
      permissions: ["things.read"],
    });
  });

  it("lists its keys sorted, for coverage assertions", () => {
    const reqs = newRequirements()
      .require("GET /z", "z.read")
      .markPublic("GET /a")
      .build();

    expect(reqs.keys()).toEqual(["GET /a", "GET /z"]);
  });
});

describe("assertRoutesDeclared", () => {
  const reqs = newRequirements()
    .require("GET /recipes/:id", "recipes.read")
    .markPublic("GET /healthz")
    .build();

  it("passes when every registered route is accounted for", () => {
    expect(() => {
      assertRoutesDeclared(["GET /recipes/:id", "GET /healthz"], reqs);
    }).not.toThrow();
  });

  it("names every route the table does not cover", () => {
    // This is the check platform-go could not have: a route nobody declared is caught before the
    // first request rather than by a caller.
    try {
      assertRoutesDeclared(
        ["GET /recipes/:id", "GET /healthz", "DELETE /recipes/:id"],
        reqs,
      );
    } catch (err) {
      expect(isRouteCoverage(err)).toBe(true);
      expect((err as RouteCoverageError).undeclared).toEqual(["DELETE /recipes/:id"]);
      expect((err as RouteCoverageError).message).toContain("DELETE /recipes/:id");
      return;
    }
    expect.unreachable("expected the coverage assertion to throw");
  });

  it("reports a rename from both sides", () => {
    // The new name is undeclared and the old one is stale; together they name the mistake far
    // more precisely than either alone.
    try {
      assertRoutesDeclared(["GET /recipes/:recipeID", "GET /healthz"], reqs);
    } catch (err) {
      expect((err as RouteCoverageError).undeclared).toEqual(["GET /recipes/:recipeID"]);
      expect((err as RouteCoverageError).stale).toEqual(["GET /recipes/:id"]);
      return;
    }
    expect.unreachable("expected the coverage assertion to throw");
  });

  it("tolerates a stale declaration when told to", () => {
    // One shared table can intentionally cover more than a given server registers.
    expect(() => {
      assertRoutesDeclared(["GET /healthz"], reqs, { allowStaleDeclarations: true });
    }).not.toThrow();
  });

  it("ignores duplicate entries in the router's route list", () => {
    expect(() => {
      assertRoutesDeclared(["GET /healthz", "GET /healthz", "GET /recipes/:id"], reqs);
    }).not.toThrow();
  });
});
