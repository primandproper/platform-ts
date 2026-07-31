import { describe, expect, it, vi } from "vitest";

import { isInvalidPolicy } from "../errors.js";
import type { Role } from "../policy.js";

import { StaticPolicyResolver } from "./static.js";

const roles: Role[] = [
  { name: "reader", description: "reads recipes", permissions: ["recipes.read"] },
  { name: "author", permissions: ["recipes.create"], inherits: ["reader"] },
  { name: "billing", permissions: ["billing.refund"] },
];

describe("StaticPolicyResolver", () => {
  it("resolves a single role to its effective permissions", async () => {
    const resolver = new StaticPolicyResolver(roles);
    const set = await resolver.permissionsForRoles(["author"]);
    expect(set.values()).toEqual(["recipes.create", "recipes.read"]);
  });

  it("unions several roles", async () => {
    const resolver = new StaticPolicyResolver(roles);
    const set = await resolver.permissionsForRoles(["author", "billing"]);
    expect(set.values()).toEqual(["billing.refund", "recipes.create", "recipes.read"]);
  });

  it("resolves the same answer regardless of the order roles are given", () => {
    const resolver = new StaticPolicyResolver(roles);
    expect(
      resolver
        .resolve(["billing", "author"])
        .equals(resolver.resolve(["author", "billing"])),
    ).toBe(true);
  });

  it("returns the memoized set on a repeat multi-role resolution", () => {
    const resolver = new StaticPolicyResolver(roles);
    expect(resolver.resolve(["author", "billing"])).toBe(
      resolver.resolve(["author", "billing"]),
    );
  });

  it("grants nothing for no roles", async () => {
    const resolver = new StaticPolicyResolver(roles);
    expect((await resolver.permissionsForRoles([])).isEmpty()).toBe(true);
  });

  it("lets an unknown role contribute nothing rather than throwing", async () => {
    // A principal still assigned a role the policy has since dropped loses that authority,
    // rather than losing the ability to make requests at all.
    const resolver = new StaticPolicyResolver(roles);
    expect((await resolver.permissionsForRoles(["ghost"])).isEmpty()).toBe(true);
    expect((await resolver.permissionsForRoles(["ghost", "billing"])).values()).toEqual([
      "billing.refund",
    ]);
  });

  it("rejects a malformed policy at construction", () => {
    // A policy mistake fails at startup rather than as a puzzling denial later.
    try {
      new StaticPolicyResolver([{ name: "loop", permissions: [], inherits: ["loop"] }]);
    } catch (err) {
      expect(isInvalidPolicy(err, "self-inheritance")).toBe(true);
      return;
    }
    expect.unreachable("expected construction to throw");
  });

  it("builds with no roles, denies everything, and warns", async () => {
    // The default configuration has to build — but a service that denies every request is far
    // more likely a missing configuration than an intent, so it says so.
    const warn = vi.fn();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
      child: (): unknown => logger,
    };

    const resolver = new StaticPolicyResolver([], {
      logger: logger as never,
    });

    expect((await resolver.permissionsForRoles(["anything"])).isEmpty()).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("does not warn when a policy was supplied", () => {
    const warn = vi.fn();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
      child: (): unknown => logger,
    };

    new StaticPolicyResolver(roles, { logger: logger as never });

    expect(warn).not.toHaveBeenCalled();
  });

  it("resolves synchronously for callers that know the policy is compiled in", () => {
    // Public on purpose: a static policy genuinely resolves without I/O, and a caller should not
    // have to await a promise that was never going to yield.
    const resolver = new StaticPolicyResolver(roles);
    expect(resolver.resolve(["reader"]).has("recipes.read")).toBe(true);
  });

  it("agrees with itself across the sync and async paths", async () => {
    const resolver = new StaticPolicyResolver(roles);
    const [sync, async] = [
      resolver.resolve(["author", "billing"]),
      await resolver.permissionsForRoles(["author", "billing"]),
    ];
    expect(sync.equals(async)).toBe(true);
  });
});

describe("StaticPolicyResolver policy isolation", () => {
  it("copies the policy in, so a later mutation cannot edit it", async () => {
    const permissions = ["recipes.read"];
    const mutable: Role[] = [{ name: "reader", permissions }];
    const resolver = new StaticPolicyResolver(mutable);

    permissions.push("recipes.delete");
    mutable.push({ name: "sneaky", permissions: ["everything"] });

    expect((await resolver.permissionsForRoles(["reader"])).values()).toEqual([
      "recipes.read",
    ]);
    expect((await resolver.permissionsForRoles(["sneaky"])).isEmpty()).toBe(true);
  });

  it("hands out roles that share nothing with its own state", async () => {
    const resolver = new StaticPolicyResolver(roles);

    const first = await resolver.roles();
    // Cast because `Role.permissions` is readonly: the point of the test is that reaching past
    // the type still cannot touch the resolver's copy.
    (first[0]?.permissions as string[]).push("injected");
    first.length = 0;

    const second = await resolver.roles();
    expect(second).toHaveLength(roles.length);
    expect(second.find((r) => r.name === "reader")?.permissions).toEqual([
      "recipes.read",
    ]);
    // Two calls share no array either, so one caller's edit cannot reach another's copy.
    expect(second[0]).not.toBe(first[0]);
  });

  it("reports every role, with descriptions and inheritance intact", async () => {
    const listed = await new StaticPolicyResolver(roles).roles();
    expect(listed.map((r) => r.name).sort()).toEqual(["author", "billing", "reader"]);
    expect(listed.find((r) => r.name === "reader")?.description).toBe("reads recipes");
    expect(listed.find((r) => r.name === "author")?.inherits).toEqual(["reader"]);
  });
});
