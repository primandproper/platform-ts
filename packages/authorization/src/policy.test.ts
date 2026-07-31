import { describe, expect, it } from "vitest";

import { isInvalidPolicy } from "./errors.js";
import { emptyPermissionSet, PermissionSet } from "./permission.js";
import {
  expandInheritance,
  isPolicyInvalidator,
  validateRoles,
  type PolicyInvalidator,
  type PolicyResolver,
  type Role,
} from "./policy.js";

const roles: Role[] = [
  { name: "reader", permissions: ["recipes.read"] },
  { name: "author", permissions: ["recipes.create"], inherits: ["reader"] },
  { name: "editor", permissions: ["recipes.update"], inherits: ["author"] },
];

/** Asserts `fn` throws an InvalidPolicyError with the given `problem`. */
function expectProblem(fn: () => unknown, problem: string): void {
  try {
    fn();
  } catch (err) {
    expect(isInvalidPolicy(err, problem as never)).toBe(true);
    return;
  }
  expect.unreachable(`expected a ${problem} policy error`);
}

describe("validateRoles", () => {
  it("accepts a well-formed policy", () => {
    expect(() => {
      validateRoles(roles);
    }).not.toThrow();
  });

  it("accepts an empty policy", () => {
    expect(() => {
      validateRoles([]);
    }).not.toThrow();
  });

  it("rejects an unnamed role", () => {
    expectProblem(() => {
      validateRoles([{ name: "", permissions: [] }]);
    }, "empty-role-name");
  });

  it("rejects a duplicate role name", () => {
    expectProblem(() => {
      validateRoles([
        { name: "reader", permissions: ["a"] },
        { name: "reader", permissions: ["b"] },
      ]);
    }, "duplicate-role");
  });

  it("rejects inheritance from a role the policy does not define", () => {
    expectProblem(() => {
      validateRoles([{ name: "author", permissions: [], inherits: ["ghost"] }]);
    }, "unknown-parent-role");
  });

  it("rejects a role inheriting from itself", () => {
    expectProblem(() => {
      validateRoles([{ name: "loop", permissions: [], inherits: ["loop"] }]);
    }, "self-inheritance");
  });

  it("rejects an inheritance cycle", () => {
    expectProblem(() => {
      validateRoles([
        { name: "a", permissions: [], inherits: ["b"] },
        { name: "b", permissions: [], inherits: ["c"] },
        { name: "c", permissions: [], inherits: ["a"] },
      ]);
    }, "inheritance-cycle");
  });

  it("names the same cycle on every run, so the error is actionable", () => {
    const cyclic: Role[] = [
      { name: "x", permissions: [], inherits: ["y"] },
      { name: "y", permissions: [], inherits: ["x"] },
      { name: "p", permissions: [], inherits: ["q"] },
      { name: "q", permissions: [], inherits: ["p"] },
    ];
    const messages = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      try {
        validateRoles(cyclic);
      } catch (err) {
        messages.add((err as Error).message);
      }
    }
    expect(messages.size).toBe(1);
  });

  it("accepts a diamond, which is not a cycle", () => {
    expect(() => {
      validateRoles([
        { name: "base", permissions: ["read"] },
        { name: "left", permissions: ["l"], inherits: ["base"] },
        { name: "right", permissions: ["r"], inherits: ["base"] },
        { name: "top", permissions: [], inherits: ["left", "right"] },
      ]);
    }).not.toThrow();
  });
});

describe("expandInheritance", () => {
  it("applies inheritance transitively", () => {
    const expanded = expandInheritance(roles);

    expect(expanded.get("reader")?.values()).toEqual(["recipes.read"]);
    expect(expanded.get("author")?.values()).toEqual(["recipes.create", "recipes.read"]);
    // editor -> author -> reader, all three levels.
    expect(expanded.get("editor")?.values()).toEqual([
      "recipes.create",
      "recipes.read",
      "recipes.update",
    ]);
  });

  it("unions several parents rather than ordering them", () => {
    const expanded = expandInheritance([
      { name: "base", permissions: ["read"] },
      { name: "left", permissions: ["l"], inherits: ["base"] },
      { name: "right", permissions: ["r"], inherits: ["base"] },
      { name: "top", permissions: ["t"], inherits: ["left", "right"] },
    ]);

    expect(expanded.get("top")?.values()).toEqual(["l", "r", "read", "t"]);
  });

  it("validates first, so a malformed policy yields no partial expansion", () => {
    expect(() =>
      expandInheritance([{ name: "a", permissions: ["x"], inherits: ["ghost"] }]),
    ).toThrow();
  });

  it("leaves the caller's roles untouched", () => {
    const input: Role[] = [{ name: "reader", permissions: ["recipes.read"] }];
    expandInheritance(input);
    expect(input[0]?.permissions).toEqual(["recipes.read"]);
  });
});

describe("isPolicyInvalidator", () => {
  const base: PolicyResolver = {
    permissionsForRoles: () => Promise.resolve(emptyPermissionSet),
    roles: () => Promise.resolve([]),
  };

  it("is false for a resolver that only resolves", () => {
    expect(isPolicyInvalidator(base)).toBe(false);
  });

  it("is true once both invalidation methods are present", () => {
    const caching = {
      ...base,
      invalidate: () => Promise.resolve(),
      invalidateAll: () => Promise.resolve(),
    };
    expect(isPolicyInvalidator(caching)).toBe(true);
  });

  it("is false when only half the contract is implemented", () => {
    const halfway: PolicyResolver & Partial<PolicyInvalidator> = {
      ...base,
      invalidateAll: () => Promise.resolve(),
    };
    expect(isPolicyInvalidator(halfway)).toBe(false);
  });
});

describe("PermissionSet as the resolver's currency", () => {
  it("is what expansion produces, so backends are interchangeable by construction", () => {
    for (const set of expandInheritance(roles).values()) {
      expect(set).toBeInstanceOf(PermissionSet);
    }
  });
});
