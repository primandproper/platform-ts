import { PermissionSet, permissionSetFromJSON, type Permission } from "./permission.js";

/**
 * A principal's effective authority for a single request: one or more granted permission sets,
 * OR'd together.
 *
 * It holds an array of sets rather than a materialized union deliberately. Merging a service-wide
 * set and an account-scoped set of a few hundred permissions each would allocate a set of their
 * combined size on every request; OR-ing at lookup allocates nothing.
 *
 * {@link denyAll} — which is what an unpopulated `Grants` is — denies everything, so a missing
 * extractor, a failed authentication, or a field nobody set is safe by construction rather than by
 * remembering to check.
 */
export class Grants {
  readonly #sets: readonly PermissionSet[];
  readonly #all: boolean;

  /** @internal Use {@link newGrants}, {@link allowAll}, or {@link denyAll}. */
  private constructor(sets: readonly PermissionSet[], all: boolean) {
    this.#sets = sets;
    this.#all = all;
  }

  /** @internal */
  static build(sets: readonly PermissionSet[], all: boolean): Grants {
    return new Grants(sets, all);
  }

  /** Reports whether any of the granted sets contains `perm`. */
  has(perm: Permission): boolean {
    if (this.#all) {
      return true;
    }
    for (const set of this.#sets) {
      if (set.has(perm)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Reports whether every permission in `perms` is granted.
   *
   * Calling it with no permissions is vacuously `true`, so a list that reached zero length by
   * accident authorizes everyone. {@link PermissionSet.hasAll} carries the full matrix of which
   * declaration sites guard the empty case and how — read it before calling this from anything
   * that decides access. Code deciding access from a *derived* list should route it through an
   * `Enforcer` instead, which denies the empty case rather than vacuously allowing it.
   */
  hasAll(perms: Iterable<Permission>): boolean {
    for (const p of perms) {
      if (!this.has(p)) {
        return false;
      }
    }
    return true;
  }

  /** Reports whether any permission in `perms` is granted. */
  hasAny(perms: Iterable<Permission>): boolean {
    for (const p of perms) {
      if (this.has(p)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Reports the outcome for each permission in `perms`.
   *
   * This is the shape a "what can I do" endpoint needs in order to tell a client which controls to
   * render. The returned record always has an entry for every requested permission, **including
   * the `false` ones** — a caller distinguishing "denied" from "not asked" needs that distinction
   * to survive the round trip.
   */
  evaluate(perms: Iterable<Permission>): Record<Permission, boolean> {
    const out: Record<Permission, boolean> = {};
    for (const p of perms) {
      out[p] = this.has(p);
    }
    return out;
  }

  /** The permissions missing from `perms`, in the order given. Empty when {@link hasAll} would be `true`. */
  missing(perms: Iterable<Permission>): Permission[] {
    const out: Permission[] = [];
    for (const p of perms) {
      if (!this.has(p)) {
        out.push(p);
      }
    }
    return out;
  }

  /** Reports whether these grants permit nothing at all. */
  isEmpty(): boolean {
    return !this.#all && this.#sets.length === 0;
  }

  /** Reports whether these grants came from {@link allowAll}. Enforcement logs it; nothing else should branch on it. */
  isAllowAll(): boolean {
    return this.#all;
  }
}

/**
 * Builds {@link Grants} from one or more permission sets. Sets that grant nothing are dropped.
 *
 * Dropping them is what makes the awkward case structural rather than conditional: a service
 * administrator acting on a tenant they are not a member of simply carries one set instead of two.
 * Callers do not check for it, and cannot forget to. That case is the one most likely to be
 * forgotten, which is why it is handled by construction here rather than by a branch out there.
 */
export function newGrants(...sets: readonly (PermissionSet | undefined)[]): Grants {
  const kept = sets.filter((s): s is PermissionSet => s !== undefined && !s.isEmpty());
  return Grants.build(kept, false);
}

/**
 * Grants that permit everything.
 *
 * It exists for tests and local development, and it is deliberately a function call at a call site
 * rather than a configurable provider: turning authorization off should be visible in a diff, not
 * reachable by setting an environment variable in production.
 */
export function allowAll(): Grants {
  return Grants.build([], true);
}

/** Grants that permit nothing. The default, named. */
export function denyAll(): Grants {
  return Grants.build([], false);
}

/**
 * Pulls a principal's authority out of whatever a consumer's request context happens to be.
 *
 * It is a function rather than an interface so this package never needs to know how a consumer
 * represents a session. The consumer writes the adapter over whatever its authentication layer
 * produced, and that adapter is where a multi-scope model collapses into the flat "these sets,
 * OR'd" this package understands:
 *
 * ```ts
 * const extract: GrantsExtractor<Ctx> = (ctx) => {
 *   const session = ctx.get("session");
 *   if (session === undefined) return undefined;
 *   return newGrants(
 *     session.servicePermissions,                        // may be undefined
 *     session.accountPermissions[session.activeAccount],  // absent key -> undefined
 *   );
 * };
 * ```
 *
 * Returning `undefined` means "no authority could be determined", which every enforcement path
 * treats as a denial — not as an error, and never as a pass.
 */
export type GrantsExtractor<Ctx> = (ctx: Ctx) => Grants | undefined;

/**
 * Hydrates {@link Grants} from decoded session JSON — the browser's entry point into this package.
 *
 * Each value is passed through {@link permissionSetFromJSON}, so a payload whose shape drifted
 * costs its holder authority rather than throwing mid-render. Pass every scope the session carries;
 * the ones that grant nothing drop out.
 */
export function grantsFromJSON(...values: readonly unknown[]): Grants {
  return newGrants(...values.map(permissionSetFromJSON));
}
