import {
  ensureLogger,
  type Logger,
  type ObservabilityDeps,
} from "@primandproper/observability";

import { PermissionDeniedError } from "./errors.js";
import type { GrantsExtractor } from "./grants.js";
import { enforcementInstruments, type EnforcementInstruments } from "./instruments.js";
import type { Permission } from "./permission.js";
import type { Requirements } from "./requirements.js";

/** Names the enforcer's logger and its instruments. */
const o11yName = "authorization";

/**
 * Why a decision came out the way it did.
 *
 * The three wiring-bug reasons — `empty-requirement`, `no-grants`, `undeclared` — are worth
 * separating from an ordinary `missing-permissions` denial, because they mean the service is
 * enforcing something other than what its author intended rather than that a caller overreached.
 */
export type DecisionReason =
  | "allowed"
  | "public"
  | "empty-requirement"
  | "no-grants"
  | "missing-permissions"
  | "undeclared";

/** The outcome of one authorization decision. */
export interface Decision {
  /**
   * Whether the request may proceed.
   *
   * This is the honest verdict, always. Audit-only mode changes what an enforcer *does* with a
   * `false` — it lets the request through — not what it reports here.
   */
  readonly allowed: boolean;
  /** Why. */
  readonly reason: DecisionReason;
  /** The permissions the requester did not hold. Diagnostic only — never put this in a response body. */
  readonly missing: readonly Permission[];
  /** The requirements-table key this decision was made for, when it was table-driven. */
  readonly key: string | undefined;
}

/**
 * What a middleware calls to hand control to the next one.
 *
 * Typed loosely on purpose: hono returns a promise, koa returns a promise, and an express-style
 * `next` returns nothing. `await`ing all three is correct.
 */
export type Next = () => unknown;

/**
 * Middleware in the `(ctx, next)` shape hono and koa use.
 *
 * A denial **throws** {@link PermissionDeniedError} rather than writing a response, because this
 * package cannot know a consumer's error envelope and should not guess at one. The framework's
 * own error hook — `app.onError` on hono, an error middleware on express — turns it into a 403,
 * which also means a denial looks identical whether it came from here or from a handler that
 * threw the same error itself.
 *
 * For an express-style `(req, res, next)` signature, adapt at the call site:
 *
 * ```ts
 * const toExpress = (mw: Middleware<Request>) =>
 *   (req: Request, _res: Response, next: NextFunction) => {
 *     mw(req, async () => undefined).then(() => { next(); }, next);
 *   };
 * ```
 */
export type Middleware<Ctx> = (ctx: Ctx, next: Next) => Promise<void>;

/** How to build an {@link Enforcer}. */
export interface EnforcerOptions<Ctx> {
  /** Bridges a consumer's request context to the authority it carries. Returning `undefined` denies. */
  extract: GrantsExtractor<Ctx>;
  /** The frozen table {@link Enforcer.enforce} looks routes up in. Required only for table-driven enforcement. */
  requirements?: Requirements;
  /**
   * Evaluate and record every decision, but deny nothing.
   *
   * This is the rollout tool. Turning enforcement on across a service that never had it is
   * otherwise a bet that every declaration is right on the first try. Deploy with it, watch
   * `authorization.denials` and `authorization.undeclared` settle to zero, then remove it.
   *
   * It is the only mode in which an unauthorized request proceeds, which is why it is a code-level
   * option rather than configuration, and why it announces itself in the log at construction.
   */
  auditOnly?: boolean;
  /** Logger, tracer, and meter. Absent ones become noops. */
  deps?: ObservabilityDeps;
}

/**
 * Decides whether a request may proceed, and says so by throwing.
 *
 * The decision itself is `Grants.hasAll` — synchronous, infallible, a few map lookups. What this
 * adds is the part that is easy to get wrong exactly once: the empty-list guard, the
 * fail-closed behaviour for a route nobody declared, and instruments that distinguish "a caller
 * overreached" from "this service is not enforcing what its author thought it was".
 *
 * Two ways to declare what a route needs, and they are the two platform-go ships:
 *
 * ```ts
 * // At the registration site — the requirement sits next to the handler it guards.
 * app.get("/recipes/:id", enforcer.require("recipes.read"), readRecipe);
 *
 * // Or from a frozen table, installed once — an undeclared route is denied.
 * app.use(enforcer.enforce((c) => `${c.req.method} ${c.req.routePath}`));
 * ```
 *
 * The table is the stronger of the two and the one to prefer where a framework exposes a matched
 * route pattern, because only it can fail closed on a route nobody guarded — and only it supports
 * {@link import("./requirements.js").assertRoutesDeclared}, which moves that failure to startup.
 */
export class Enforcer<Ctx> {
  readonly #extract: GrantsExtractor<Ctx>;
  readonly #requirements: Requirements | undefined;
  readonly #auditOnly: boolean;
  readonly #logger: Logger;
  readonly #instruments: EnforcementInstruments;

  /** @internal Use {@link newEnforcer}. */
  constructor(options: EnforcerOptions<Ctx>) {
    this.#extract = options.extract;
    this.#requirements = options.requirements;
    this.#auditOnly = options.auditOnly ?? false;
    this.#logger = ensureLogger(options.deps?.logger).child(o11yName);
    this.#instruments = enforcementInstruments(o11yName, options.deps);

    if (this.#auditOnly) {
      this.#logger.info(
        "authorization enforcer running in audit-only mode; denials will be recorded but not enforced",
      );
    }
  }

  /**
   * Decides `ctx` against an explicit list of required permissions, recording the decision.
   *
   * **An empty `required` denies.** Set algebra says a universal quantifier over nothing is
   * vacuously true, and `Grants.hasAll([])` honestly returns `true` for that reason — but a
   * *guard* installed with an empty list is far more likely to be a list that came back empty from
   * configuration than an intent to admit everyone, and a route that needs no authorization simply
   * carries no guard. This is the middleware row of the matrix in the package README.
   */
  decide(ctx: Ctx, required: readonly Permission[]): Decision {
    return this.#decide(ctx, required, undefined);
  }

  /**
   * Decides `ctx` against what the requirements table says `key` demands.
   *
   * A key the table does not declare is **denied**, which is what makes "public" a declaration
   * rather than an omission. Throws if the enforcer was built without a table, since silently
   * denying every route would look exactly like a policy that denies every route.
   */
  decideDeclared(ctx: Ctx, key: string): Decision {
    const requirements = this.#requirements;
    if (requirements === undefined) {
      throw new TypeError(
        "this enforcer was built without a requirements table; pass `requirements` to newEnforcer",
      );
    }

    const requirement = requirements.lookup(key);

    if (requirement === undefined) {
      // A different bug from a denied request: the table is incomplete, not that a caller
      // overreached. Counted separately and logged at a level that gets noticed.
      this.#instruments.checks.add(1, { key });
      this.#instruments.undeclared.add(1, { key });
      this.#logger.error(
        "denying request for a route with no declared authorization requirements",
        new PermissionDeniedError(),
        { key },
      );
      return this.#denied("undeclared", [], key);
    }

    if (requirement.kind === "public") {
      this.#instruments.checks.add(1, { key });
      return { allowed: true, reason: "public", missing: [], key };
    }

    return this.#decide(ctx, requirement.permissions, key);
  }

  /**
   * Decides, and throws {@link PermissionDeniedError} on a denial.
   *
   * For a check inside a handler, where the requirement depends on the request body and cannot be
   * declared at the route. Audit-only mode is honoured here too: it records the denial and returns
   * normally.
   */
  authorize(ctx: Ctx, ...required: readonly Permission[]): void {
    this.#raise(this.decide(ctx, required));
  }

  /**
   * Middleware admitting only requests whose grants include every permission in `required`.
   *
   * Declaring at the registration site puts the requirement next to the handler it guards, which
   * is where a reader is most likely to notice its absence. It cannot detect a route registered
   * *without* a guard, though — for that, use {@link Enforcer.enforce} with a table.
   *
   * `required` is copied, so a caller mutating its own array afterwards cannot change what the
   * route demands.
   */
  require(...required: readonly Permission[]): Middleware<Ctx> {
    const frozen = [...required];
    return async (ctx, next) => {
      this.#raise(this.decide(ctx, frozen));
      await next();
    };
  }

  /**
   * Middleware that looks each request's requirement up in the table, installed once for a whole
   * server.
   *
   * `keyOf` derives the table key from the request context — typically the matched route pattern,
   * `` `${method} ${pattern}` ``, or a gRPC full method name. It must return the pattern rather
   * than the raw path: a raw path carries a resource identifier, so it would never match a
   * declaration and every request would be denied as undeclared. Returning `undefined` — a router
   * that has not matched yet, say — is treated as undeclared and denied.
   */
  enforce(keyOf: (ctx: Ctx) => string | undefined): Middleware<Ctx> {
    return async (ctx, next) => {
      const key = keyOf(ctx);
      this.#raise(key === undefined ? this.#unmatched() : this.decideDeclared(ctx, key));
      await next();
    };
  }

  /** Reports whether this enforcer records decisions without acting on them. */
  isAuditOnly(): boolean {
    return this.#auditOnly;
  }

  #decide(ctx: Ctx, required: readonly Permission[], key: string | undefined): Decision {
    const attrs = key === undefined ? undefined : { key };
    this.#instruments.checks.add(1, attrs);

    if (required.length === 0) {
      this.#instruments.emptyRequirements.add(1, attrs);
      this.#logger.error(
        "denying request for a route guarded by an empty permission list",
        new PermissionDeniedError(),
        key === undefined ? {} : { key },
      );
      return this.#denied("empty-requirement", [], key);
    }

    const grants = this.#extract(ctx);
    if (grants === undefined) {
      // Usually means authentication did not run, or ran after this — a wiring bug rather than an
      // overreaching caller, so it gets its own counter and a level that gets noticed.
      this.#instruments.missingGrants.add(1, attrs);
      this.#logger.error(
        "no grants available for a request requiring authorization",
        new PermissionDeniedError(required),
        key === undefined ? {} : { key },
      );
      return this.#denied("no-grants", required, key);
    }

    const missing = grants.missing(required);
    if (missing.length > 0) {
      this.#logger.debug("denying request for missing permissions", {
        ...(key === undefined ? {} : { key }),
        missing,
      });
      return this.#denied("missing-permissions", missing, key);
    }

    return { allowed: true, reason: "allowed", missing: [], key };
  }

  /** A context whose key could not be derived: nothing was declared for it, so nothing admits it. */
  #unmatched(): Decision {
    this.#instruments.checks.add(1);
    this.#instruments.undeclared.add(1);
    this.#logger.error(
      "denying request whose authorization key could not be determined",
      new PermissionDeniedError(),
    );
    return this.#denied("undeclared", [], undefined);
  }

  #denied(
    reason: DecisionReason,
    missing: readonly Permission[],
    key: string | undefined,
  ): Decision {
    this.#instruments.denials.add(1, key === undefined ? undefined : { key });
    return { allowed: false, reason, missing: [...missing], key };
  }

  /** Turns a decision into the caller's outcome, honouring audit-only mode. */
  #raise(decision: Decision): void {
    if (decision.allowed || this.#auditOnly) {
      return;
    }
    throw new PermissionDeniedError(decision.missing);
  }
}

/**
 * Builds an {@link Enforcer}.
 *
 * ```ts
 * const enforcer = newEnforcer({
 *   extract: (c) => c.get("grants"),
 *   requirements: newRequirements()
 *     .require("GET /recipes/:id", "recipes.read")
 *     .markPublic("GET /healthz")
 *     .build(),
 *   deps: { logger, metrics },
 * });
 * ```
 */
export function newEnforcer<Ctx>(options: EnforcerOptions<Ctx>): Enforcer<Ctx> {
  return new Enforcer(options);
}
