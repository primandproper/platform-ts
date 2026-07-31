import { ensureLogger, type ObservabilityDeps } from "@primandproper/observability";

import { emptyPermissionSet, PermissionSet } from "../permission.js";
import { expandInheritance, type PolicyResolver, type Role } from "../policy.js";

/**
 * A {@link PolicyResolver} whose policy is fixed at construction.
 *
 * This is the default backend and the one to reach for until something forces otherwise: it needs
 * no database, no migrations, and no configuration, and it resolves without I/O. Policy lives
 * wherever the caller declares its roles — as TypeScript constants, or as JSON/YAML loaded into
 * config.
 *
 * Graduate to a stored policy only when roles themselves must become editable data: when an
 * operator has to define a new role, or change what an existing one grants, without shipping a
 * release. Reassigning which roles a principal holds does not require it — role assignments belong
 * to the consumer either way, because they reference the consumer's own users and tenants. This
 * package owns policy, not assignment.
 */
export class StaticPolicyResolver implements PolicyResolver {
  readonly #expanded: ReadonlyMap<string, PermissionSet>;
  readonly #roles: readonly Role[];
  readonly #memo = new Map<string, PermissionSet>();

  /**
   * Builds a resolver over `roles`, expanding inheritance once.
   *
   * It throws {@link InvalidPolicyError} for a malformed policy — an unnamed role, a duplicate, a
   * parent that is not defined, or an inheritance cycle — so a policy mistake fails at startup
   * rather than as a puzzling denial later.
   *
   * Zero roles is valid and produces a resolver that denies everything. That is deliberate: the
   * default configuration has to build, or the default provider would not be usable without setup.
   * It logs a warning, because a service that denies every request is far more likely to be a
   * missing configuration than an intent.
   */
  constructor(roles: readonly Role[] = [], deps?: ObservabilityDeps) {
    this.#expanded = expandInheritance(roles);
    // Cloned so a caller mutating its own array afterwards cannot edit the live policy.
    this.#roles = roles.map((role) => ({
      ...role,
      permissions: [...role.permissions],
      ...(role.inherits === undefined ? {} : { inherits: [...role.inherits] }),
    }));

    if (roles.length === 0) {
      ensureLogger(deps?.logger)
        .child("authorization_static")
        .warn(
          "static policy resolver constructed with no roles; all authorization checks will deny",
        );
    }
  }

  /**
   * The union of the effective permissions of the named roles. It never rejects: the policy was
   * validated at construction and resolution touches nothing outside this process.
   */
  async permissionsForRoles(roles: readonly string[]): Promise<PermissionSet> {
    return this.resolve(roles);
  }

  /**
   * The synchronous core. It is public because a static policy genuinely resolves without I/O, and
   * a caller that knows it configured this backend should not have to `await` a promise that was
   * never going to yield. Code written against {@link PolicyResolver} uses the async method and
   * stays portable across backends.
   */
  resolve(roles: readonly string[]): PermissionSet {
    const [only] = roles;
    if (only === undefined) {
      return emptyPermissionSet;
    }
    if (roles.length === 1) {
      // The overwhelmingly common case, and it needs neither a union nor a memo entry: the
      // expansion map already holds exactly this answer.
      return this.#expanded.get(only) ?? emptyPermissionSet;
    }

    const key = memoKey(roles);
    const memo = this.#memo.get(key);
    if (memo !== undefined) {
      return memo;
    }

    // Unknown roles contribute nothing rather than throwing, so a principal still assigned a role
    // the policy has since dropped loses that authority instead of losing the ability to make
    // requests at all.
    const sets = roles
      .map((name) => this.#expanded.get(name))
      .filter((s): s is PermissionSet => s !== undefined);

    const union = emptyPermissionSet.union(...sets);
    this.#memo.set(key, union);

    return union;
  }

  /** Every role in the policy. The result shares nothing with the resolver's state. */
  async roles(): Promise<Role[]> {
    return this.#roles.map((role) => ({
      ...role,
      permissions: [...role.permissions],
      ...(role.inherits === undefined ? {} : { inherits: [...role.inherits] }),
    }));
  }
}

/**
 * Builds a stable key for a set of role names. It sorts a copy so the same roles in a different
 * order hit the same entry, and joins on NUL because a role name cannot usefully contain one.
 */
function memoKey(roles: readonly string[]): string {
  return [...roles].sort().join("\u0000");
}
