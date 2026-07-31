import { describe, expect, it } from "vitest";

import {
  emptyPermissionSet,
  newPermissionSet,
  PermissionSet,
  permissionSetFromJSON,
} from "./permission.js";

describe("PermissionSet", () => {
  it("holds the permissions it was built with", () => {
    const set = newPermissionSet("read", "write");
    expect(set.has("read")).toBe(true);
    expect(set.has("write")).toBe(true);
    expect(set.has("delete")).toBe(false);
    expect(set.size).toBe(2);
  });

  it("collapses duplicates and drops empty strings", () => {
    const set = new PermissionSet(["read", "read", "", "write"]);
    expect(set.size).toBe(2);
    // An empty permission can never be held, so an empty check can never accidentally pass.
    expect(set.has("")).toBe(false);
  });

  it("copies its input, so a later mutation cannot edit the set", () => {
    const source = ["read"];
    const set = new PermissionSet(source);
    source.push("write");
    expect(set.has("write")).toBe(false);
  });

  it("grants nothing when empty", () => {
    expect(emptyPermissionSet.isEmpty()).toBe(true);
    expect(emptyPermissionSet.has("read")).toBe(false);
    expect(emptyPermissionSet.size).toBe(0);
  });

  it("is vacuously true for hasAll with no permissions — the documented hazard", () => {
    // Set algebra's honest answer, and the reason a derived requirement list must be checked for
    // emptiness before it reaches here.
    expect(emptyPermissionSet.hasAll([])).toBe(true);
    expect(newPermissionSet("read").hasAll([])).toBe(true);
  });

  it("is false for hasAny with no permissions — there is no witness", () => {
    expect(newPermissionSet("read").hasAny([])).toBe(false);
  });

  it("requires every permission for hasAll and any one for hasAny", () => {
    const set = newPermissionSet("read", "write");
    expect(set.hasAll(["read", "write"])).toBe(true);
    expect(set.hasAll(["read", "delete"])).toBe(false);
    expect(set.hasAny(["delete", "write"])).toBe(true);
    expect(set.hasAny(["delete"])).toBe(false);
  });

  it("orders values deterministically, so serialized forms are stable", () => {
    expect(newPermissionSet("write", "admin", "read").values()).toEqual([
      "admin",
      "read",
      "write",
    ]);
    expect([...newPermissionSet("b", "a")]).toEqual(["a", "b"]);
  });

  it("unions without mutating either operand", () => {
    const a = newPermissionSet("read");
    const b = newPermissionSet("write");

    const union = a.union(b);

    expect(union.values()).toEqual(["read", "write"]);
    expect(a.size).toBe(1);
    expect(b.size).toBe(1);
  });

  it("unions several sets at once", () => {
    expect(
      newPermissionSet("a").union(newPermissionSet("b"), newPermissionSet("c")).values(),
    ).toEqual(["a", "b", "c"]);
  });

  it("treats the empty set as a subset of everything", () => {
    expect(emptyPermissionSet.isSubsetOf(newPermissionSet("read"))).toBe(true);
    expect(newPermissionSet("read").isSubsetOf(emptyPermissionSet)).toBe(false);
  });

  it("compares by contents, not identity", () => {
    expect(newPermissionSet("a", "b").equals(newPermissionSet("b", "a"))).toBe(true);
    expect(newPermissionSet("a").equals(newPermissionSet("a", "b"))).toBe(false);
  });

  it("summarises rather than lists in toString, so telemetry cannot leak the taxonomy", () => {
    const set = newPermissionSet("billing.refund", "users.delete");
    expect(set.toString()).toBe("PermissionSet(n=2)");
    expect(set.toString()).not.toContain("billing.refund");
  });
});

describe("PermissionSet JSON round trip", () => {
  it("encodes as a sorted array through JSON.stringify", () => {
    expect(JSON.stringify(newPermissionSet("write", "read"))).toBe('["read","write"]');
  });

  it("hydrates back to an equal set", () => {
    const original = newPermissionSet("read", "write");
    const hydrated = permissionSetFromJSON(JSON.parse(JSON.stringify(original)));
    expect(hydrated.equals(original)).toBe(true);
  });

  it("costs a malformed payload its authority rather than throwing", () => {
    // Failing closed matters more than failing loudly here: throwing inside a render is the
    // worst available outcome, and an unreadable payload should grant nothing.
    for (const malformed of [undefined, null, 42, "read", { read: true }]) {
      expect(permissionSetFromJSON(malformed).isEmpty()).toBe(true);
    }
  });

  it("keeps the string entries of a mixed array and drops the rest", () => {
    expect(permissionSetFromJSON(["read", 7, null, "write"]).values()).toEqual([
      "read",
      "write",
    ]);
  });
});
