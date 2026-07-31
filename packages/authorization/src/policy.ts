import { InvalidPolicyError } from "./errors.js";
import { PermissionSet, type Permission } from "./permission.js";

/**
 * A named grant of permissions, optionally inheriting from other roles.
 *
 * The same `Role[]` value seeds every backend, which is what makes them interchangeable — and it
 * is the fix for the failure mode where a code-side role table and a stored seed drift apart
 * because nothing ever checks them against each other.
 */
export interface Role {
  /** Identifies the role. It is the string a principal's role assignments refer to, and it must be unique within a policy. */
  name: string;
  /** Human-facing documentation, surfaced by {@link PolicyResolver.roles} for admin tooling. No effect on resolution. */
  description?: string;
  /** The permissions this role grants directly, before inheritance is applied. */
  permissions: readonly Permission[];
  /**
   * The roles this role inherits from. Inheritance is transitive: a role receives the permissions
   * of its parents, its parents' parents, and so on. It is not an ordering — a role may inherit
   * from several, and the result is their union.
   */
  inherits?: readonly string[];
}

/**
 * Answers "what can these roles do".
 *
 * This is the only asynchronous, fallible, pluggable part of the package, and that is the whole
 * design: resolving policy may hit a database; checking a permission never does. Callers resolve
 * once when they build a session and check many times per request against the resulting
 * {@link Grants}.
 *
 * Implementations must be safe for concurrent use.
 */
export interface PolicyResolver {
  /**
   * The effective permissions of the named roles with inheritance expanded — the union of what
   * each role grants.
   *
   * Unknown role names contribute nothing rather than throwing: a policy that no longer defines a
   * role a principal is still assigned must fail closed, not fail the request. Use {@link roles}
   * to detect that case deliberately. Calling it with no roles returns an empty set.
   */
  permissionsForRoles(roles: readonly string[]): Promise<PermissionSet>;
  /** Every role the policy defines, for introspection and admin tooling. The order is unspecified. */
  roles(): Promise<Role[]>;
}

/**
 * The optional half of a {@link PolicyResolver} that memoizes.
 *
 * It is declared apart from `PolicyResolver` so a caller handed a resolver it did not construct
 * can reach invalidation without knowing which concrete type it was given — whether a cache sits
 * in the chain is an assembly decision, not a call-site one:
 *
 * ```ts
 * if (isPolicyInvalidator(resolver)) await resolver.invalidateAll();
 * ```
 *
 * The process that edits policy is exactly the one that needs this, and the one least likely to
 * know how its resolver was assembled.
 */
export interface PolicyInvalidator {
  /** Drops the memoized resolution for an exact set of roles. */
  invalidate(roles: readonly string[]): Promise<void>;
  /** Makes every resolution this instance memoized unreachable. Process-local: other replicas wait out their TTL. */
  invalidateAll(): Promise<void>;
}

/** Narrows a {@link PolicyResolver} to one that can also drop what it memoized. */
export function isPolicyInvalidator(
  resolver: PolicyResolver,
): resolver is PolicyResolver & PolicyInvalidator {
  const candidate = resolver as Partial<PolicyInvalidator>;
  return (
    typeof candidate.invalidate === "function" &&
    typeof candidate.invalidateAll === "function"
  );
}

/**
 * Checks that `roles` form a well-formed policy: every role named, no duplicates, every parent
 * defined, no role inheriting from itself, and no inheritance cycles.
 *
 * Every backend calls it, so a policy rejected in a compiled-in build is rejected on its way into
 * storage too. Throws {@link InvalidPolicyError}; returns nothing on success.
 */
export function validateRoles(roles: readonly Role[]): void {
  const byName = new Map<string, Role>();
  for (const role of roles) {
    if (role.name === "") {
      throw new InvalidPolicyError("empty-role-name", "role name is empty");
    }
    if (byName.has(role.name)) {
      throw new InvalidPolicyError("duplicate-role", `duplicate role name: ${role.name}`);
    }
    byName.set(role.name, role);
  }

  for (const role of roles) {
    for (const parent of role.inherits ?? []) {
      if (parent === role.name) {
        throw new InvalidPolicyError(
          "self-inheritance",
          `role ${role.name} inherits from itself`,
        );
      }
      if (!byName.has(parent)) {
        throw new InvalidPolicyError(
          "unknown-parent-role",
          `role ${role.name} inherits unknown role ${parent}`,
        );
      }
    }
  }

  detectCycles(byName);
}

/**
 * Resolves every role to its effective permission set, with inheritance applied transitively.
 *
 * It validates first, so a malformed policy is rejected here rather than producing a
 * partially-expanded result. This is the reference semantics for inheritance: any backend that
 * expands some other way (in SQL, say) owes a test asserting it agrees with this function.
 */
export function expandInheritance(roles: readonly Role[]): Map<string, PermissionSet> {
  validateRoles(roles);

  const byName = new Map<string, Role>(roles.map((r) => [r.name, r]));
  const expanded = new Map<string, PermissionSet>();

  const resolve = (name: string): PermissionSet => {
    const memo = expanded.get(name);
    if (memo !== undefined) {
      return memo;
    }

    const role = byName.get(name);
    let set = new PermissionSet(role?.permissions ?? []);

    // Marked before recursing so a cycle would terminate here. Cycles are already rejected by
    // validateRoles; this keeps the function total rather than relying on that from a distance.
    expanded.set(name, set);

    for (const parent of role?.inherits ?? []) {
      set = set.union(resolve(parent));
      expanded.set(name, set);
    }

    return set;
  };

  for (const role of roles) {
    resolve(role.name);
  }

  return expanded;
}

/** Walks the inheritance graph depth-first, reporting the first cycle it finds. */
function detectCycles(byName: ReadonlyMap<string, Role>): void {
  const state = new Map<string, "visiting" | "visited">();

  const walk = (name: string, path: readonly string[]): void => {
    const seen = state.get(name);
    if (seen === "visiting") {
      throw new InvalidPolicyError(
        "inheritance-cycle",
        `role inheritance cycle: ${[...path, name].join(" -> ")}`,
      );
    }
    if (seen === "visited") {
      return;
    }

    state.set(name, "visiting");
    for (const parent of byName.get(name)?.inherits ?? []) {
      walk(parent, [...path, name]);
    }
    state.set(name, "visited");
  };

  // Sorted so a policy with more than one cycle reports the same one every run; an error that
  // moves between runs is miserable to act on.
  for (const name of [...byName.keys()].sort()) {
    walk(name, []);
  }
}
