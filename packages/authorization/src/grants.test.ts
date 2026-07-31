import { describe, expect, it } from "vitest";

import {
  allowAll,
  denyAll,
  grantsFromJSON,
  newGrants,
  type GrantsExtractor,
} from "./grants.js";
import { emptyPermissionSet, newPermissionSet } from "./permission.js";

const service = newPermissionSet("service.admin");
const account = newPermissionSet("recipes.create", "recipes.read");

describe("Grants", () => {
  it("ORs the sets it was given", () => {
    const grants = newGrants(service, account);
    expect(grants.has("service.admin")).toBe(true);
    expect(grants.has("recipes.create")).toBe(true);
    expect(grants.has("nothing.here")).toBe(false);
  });

  it("denies everything when unpopulated", () => {
    expect(denyAll().isEmpty()).toBe(true);
    expect(denyAll().has("anything")).toBe(false);
    expect(newGrants().has("anything")).toBe(false);
  });

  it("drops sets that grant nothing, so the awkward case needs no branch", () => {
    // "Administrator acting on a tenant they are not a member of" arrives as one set, not two.
    const grants = newGrants(service, emptyPermissionSet, undefined);
    expect(grants.has("service.admin")).toBe(true);
    expect(grants.isEmpty()).toBe(false);

    expect(newGrants(emptyPermissionSet, undefined).isEmpty()).toBe(true);
  });

  it("allows everything under allowAll, and says so", () => {
    const grants = allowAll();
    expect(grants.has("anything.at.all")).toBe(true);
    expect(grants.hasAll(["a", "b"])).toBe(true);
    expect(grants.isAllowAll()).toBe(true);
    expect(grants.isEmpty()).toBe(false);
    expect(denyAll().isAllowAll()).toBe(false);
  });

  it("is vacuously true for hasAll with no permissions — the documented hazard", () => {
    expect(denyAll().hasAll([])).toBe(true);
  });

  it("requires every permission for hasAll and any one for hasAny", () => {
    const grants = newGrants(account);
    expect(grants.hasAll(["recipes.create", "recipes.read"])).toBe(true);
    expect(grants.hasAll(["recipes.create", "recipes.delete"])).toBe(false);
    expect(grants.hasAny(["recipes.delete", "recipes.read"])).toBe(true);
    expect(grants.hasAny(["recipes.delete"])).toBe(false);
  });

  it("evaluates every requested permission, including the denials", () => {
    // A client distinguishing "denied" from "not asked" needs the false entries to survive.
    expect(newGrants(account).evaluate(["recipes.read", "recipes.delete"])).toEqual({
      "recipes.read": true,
      "recipes.delete": false,
    });
  });

  it("evaluates to an empty record when asked about nothing", () => {
    expect(newGrants(account).evaluate([])).toEqual({});
  });

  it("reports what is missing, in the order asked", () => {
    expect(
      newGrants(account).missing(["recipes.delete", "recipes.read", "billing"]),
    ).toEqual(["recipes.delete", "billing"]);
    expect(newGrants(account).missing(["recipes.read"])).toEqual([]);
  });
});

describe("GrantsExtractor", () => {
  it("bridges a consumer session, collapsing scopes into one OR'd authority", () => {
    interface Session {
      servicePermissions?: ReturnType<typeof newPermissionSet>;
      accountPermissions: Record<string, ReturnType<typeof newPermissionSet>>;
      activeAccount: string;
    }
    const extract: GrantsExtractor<Session | undefined> = (session) => {
      if (session === undefined) {
        return undefined;
      }
      return newGrants(
        session.servicePermissions,
        session.accountPermissions[session.activeAccount],
      );
    };

    const grants = extract({
      accountPermissions: { acct_1: account },
      activeAccount: "acct_1",
    });
    expect(grants?.has("recipes.create")).toBe(true);

    // An account the principal is not a member of: an absent key, not a special case.
    const outsider = extract({
      servicePermissions: service,
      accountPermissions: { acct_1: account },
      activeAccount: "acct_2",
    });
    expect(outsider?.has("service.admin")).toBe(true);
    expect(outsider?.has("recipes.create")).toBe(false);

    // No authority could be determined — a denial, and never an error.
    expect(extract(undefined)).toBeUndefined();
  });
});

describe("grantsFromJSON", () => {
  it("hydrates every scope a session carries", () => {
    const grants = grantsFromJSON(["service.admin"], ["recipes.create"]);
    expect(grants.has("service.admin")).toBe(true);
    expect(grants.has("recipes.create")).toBe(true);
  });

  it("costs a malformed payload its authority rather than throwing", () => {
    expect(grantsFromJSON(undefined, "not-an-array", { nope: true }).isEmpty()).toBe(
      true,
    );
  });

  it("survives a partially malformed payload with the readable scopes intact", () => {
    const grants = grantsFromJSON(["service.admin"], null);
    expect(grants.has("service.admin")).toBe(true);
  });
});
