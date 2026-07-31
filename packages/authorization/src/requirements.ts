import {
  InvalidRequirementsError,
  RouteCoverageError,
  type RequirementProblem,
} from "./errors.js";
import type { Permission } from "./permission.js";

/** What a declared key demands, as the table stores it. */
export type Requirement =
  | { readonly kind: "permissions"; readonly permissions: readonly Permission[] }
  | { readonly kind: "public" };

/**
 * The frozen table of what each route or method demands.
 *
 * It is immutable once built, which is why enforcement needs no lock and no defensive copy on the
 * hot path: a map that is never written after startup does not need protecting on every request.
 *
 * **A key absent from the table is denied.** Being public is a declaration, never an omission —
 * forgetting to declare a route fails closed, and {@link assertRoutesDeclared} turns that failure
 * into a startup crash rather than a 403 someone reports later.
 */
export class Requirements {
  readonly #byKey: ReadonlyMap<string, Requirement>;

  /** @internal Use {@link newRequirements}. */
  private constructor(byKey: ReadonlyMap<string, Requirement>) {
    this.#byKey = byKey;
  }

  /** @internal */
  static build(byKey: ReadonlyMap<string, Requirement>): Requirements {
    return new Requirements(byKey);
  }

  /**
   * What `key` demands, or `undefined` when it was never declared.
   *
   * The `undefined` is the fail-closed path and callers must treat it as a denial rather than as
   * "nothing required".
   */
  lookup(key: string): Requirement | undefined {
    return this.#byKey.get(key);
  }

  /**
   * Every declared key, sorted.
   *
   * It exists so a consumer can assert its table covers everything its server registers — the
   * check that turns "we remembered to declare everything" from a convention into a test. See
   * {@link assertRoutesDeclared}.
   */
  keys(): string[] {
    return [...this.#byKey.keys()].sort();
  }

  /** The number of declared keys. */
  get size(): number {
    return this.#byKey.size;
  }
}

/**
 * Accumulates declarations and validates them as a whole.
 *
 * Every method returns the builder, so declarations chain. Nothing is validated until
 * {@link RequirementsBuilder.build}, which is what lets it report every problem at once.
 */
export class RequirementsBuilder {
  readonly #byKey = new Map<string, Requirement>();
  readonly #declaredCount = new Map<string, number>();
  readonly #problems: RequirementProblem[] = [];

  /**
   * Declares that `key` demands every permission in `permissions`.
   *
   * Declaring zero permissions is a **build error** rather than a way to say "any authenticated
   * caller": it reads as a requirement while behaving as an allow, and that gap is exactly where
   * an authorization hole hides. Say {@link RequirementsBuilder.markPublic} instead, which means
   * the same thing and looks like it.
   */
  require(key: string, ...permissions: readonly Permission[]): this {
    this.#count(key);

    if (key === "") {
      this.#problems.push({
        kind: "empty-key",
        key: "",
        message: "a requirement was declared for an empty key",
      });
    } else if (permissions.length === 0) {
      this.#problems.push({
        kind: "no-permissions-required",
        key,
        message: `${key} was required with no permissions; use markPublic to declare it needs none`,
      });
    }

    for (const permission of permissions) {
      if (permission === "") {
        this.#problems.push({
          kind: "empty-permission",
          key,
          message: `${key} requires an empty permission`,
        });
      }
    }

    if (key !== "" && permissions.length > 0) {
      // Cloned, so a caller mutating its own array afterwards cannot edit the requirement.
      this.#byKey.set(key, { kind: "permissions", permissions: [...permissions] });
    }

    return this;
  }

  /**
   * Declares requirements from a record, which is the shape a feature module naturally exports for
   * its own routes.
   *
   * Several such records merge into one table, and a key declared by two of them is reported as a
   * duplicate rather than silently taking whichever was applied last.
   */
  requireEach(declarations: Readonly<Record<string, readonly Permission[]>>): this {
    for (const key of Object.keys(declarations).sort()) {
      this.require(key, ...(declarations[key] ?? []));
    }
    return this;
  }

  /**
   * Declares that `key` requires no authorization.
   *
   * Named `markPublic` rather than `public` because the latter reads as a visibility modifier at
   * every call site in TypeScript. It is the only way to say "this needs nothing", and saying it
   * is mandatory: an undeclared key is denied, so forgetting to declare a route fails closed and
   * loudly, while forgetting to mark one public fails closed and obviously.
   */
  markPublic(key: string): this {
    this.#count(key);

    if (key === "") {
      this.#problems.push({
        kind: "empty-key",
        key: "",
        message: "a public declaration was made for an empty key",
      });
      return this;
    }

    this.#byKey.set(key, { kind: "public" });

    return this;
  }

  /**
   * Validates every accumulated declaration and freezes them.
   *
   * Throws {@link InvalidRequirementsError} carrying **all** the problems, not the first — a table
   * assembled from a dozen feature modules usually has more than one, and fixing them a restart at
   * a time is miserable.
   */
  build(): Requirements {
    const problems: RequirementProblem[] = [...this.#problems];

    for (const key of [...this.#declaredCount.keys()].sort()) {
      if ((this.#declaredCount.get(key) ?? 0) > 1) {
        problems.push({
          kind: "duplicate-key",
          key,
          message: `${key} was declared more than once`,
        });
      }
    }

    if (problems.length > 0) {
      throw new InvalidRequirementsError(problems);
    }

    return Requirements.build(new Map(this.#byKey));
  }

  #count(key: string): void {
    this.#declaredCount.set(key, (this.#declaredCount.get(key) ?? 0) + 1);
  }
}

/** Starts a {@link RequirementsBuilder}. */
export function newRequirements(): RequirementsBuilder {
  return new RequirementsBuilder();
}

/** Options for {@link assertRoutesDeclared}. */
export interface RouteCoverageOptions {
  /**
   * Tolerate keys the table declares that `routes` does not contain.
   *
   * Default `false`. A stale declaration is not a security hole, but it is usually a rename whose
   * new name landed in the router and not in the table — in which case the new name shows up as
   * undeclared too, and the pair together names the mistake precisely. Set this when one shared
   * table intentionally covers more than a given server registers.
   */
  allowStaleDeclarations?: boolean;
}

/**
 * Asserts that every route the server registered is accounted for by `requirements`.
 *
 * This is the check platform-go could not have. Its HTTP middleware runs before the mux has
 * matched, so a route pattern is not knowable there and an unguarded route cannot be detected at
 * all. In TypeScript the route table is enumerable at startup — `app.routes` on hono, the router
 * stack on express, `printRoutes` on fastify — so "every registered route either requires
 * permissions or is explicitly marked public" becomes a fact checked before the first request
 * instead of a convention:
 *
 * ```ts
 * assertRoutesDeclared(
 *   app.routes.map((r) => `${r.method} ${r.path}`),
 *   requirements,
 * );
 * ```
 *
 * Run it at boot, and in a test — the test tells whoever added the route what they forgot, which
 * is cheaper than a crash loop telling an on-call engineer.
 *
 * Throws {@link RouteCoverageError} naming every uncovered route at once. Duplicate entries in
 * `routes` are ignored; the router's own route list often contains them.
 */
export function assertRoutesDeclared(
  routes: Iterable<string>,
  requirements: Requirements,
  options?: RouteCoverageOptions,
): void {
  const registered = new Set(routes);

  const undeclared = [...registered]
    .filter((route) => requirements.lookup(route) === undefined)
    .sort();

  const stale =
    options?.allowStaleDeclarations === true
      ? []
      : requirements.keys().filter((key) => !registered.has(key));

  if (undeclared.length > 0 || stale.length > 0) {
    throw new RouteCoverageError(undeclared, stale);
  }
}
