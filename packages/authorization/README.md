# @primandproper/authorization

Answers "may this principal do this thing" — the TypeScript port of platform-go's
`authorization`. `authentication` establishes _who_ is calling; this establishes _what they may
do_.

## The seam

Two operations that look like one, and conflating them is the mistake the whole design exists to
avoid:

```
resolve   role names -> permission set   once per session   may do I/O
check     permission in set              many per request   never does
```

Only resolution is pluggable. **Checking is a map lookup: synchronous, infallible, allocation-free
— and that it cannot fail is the property to defend.** The tempting interface —

```ts
authorize(principal, action, resource): Promise<boolean>
```

— makes a map lookup and a network round trip indistinguishable at the call site, which is how a
permission check inside a loop becomes N round trips. It adds a rejection path with no cause, and
the tempting way to handle "engine unavailable" is to allow. In TypeScript, synchronous also means
usable directly in a React render, which is the point of the browser half: the same permission set
that gates a handler decides which controls the UI draws, so the two cannot drift.

## Checking

```ts
import { newGrants, newPermissionSet } from "@primandproper/authorization";

const grants = newGrants(servicePermissions, accountPermissions);

grants.has("recipes.create"); // boolean, right now
grants.hasAny(["recipes.update", "recipes.delete"]);
grants.evaluate(["recipes.create", "billing.refund"]); // { "recipes.create": true, ... }
```

`evaluate` returns an entry for **every** requested permission, including the `false` ones — a
client distinguishing "denied" from "not asked" needs that to survive the round trip. It is the
shape a "what can I do" endpoint hands a UI.

## No principal type

There is deliberately no `Principal` here: enforcement needs _authority_, not identity. Deriving
authority from identity requires a store, which is exactly what drags I/O onto the check.
Consumers bridge their own session type with a `GrantsExtractor`, and that adapter is also where a
multi-scope model collapses:

```ts
const extract: GrantsExtractor<Ctx> = (ctx) => {
  const session = ctx.get("session");
  if (session === undefined) return undefined; // no authority determined -> denial
  return newGrants(
    session.servicePermissions, // may be undefined
    session.accountPermissions[session.activeAccount], // absent key -> undefined
  );
};
```

Sets that grant nothing are **dropped**, so "an administrator acting on a tenant they do not
belong to" carries one set instead of two and needs no branch anywhere. That case is the one most
likely to be forgotten, so it is handled by construction rather than by remembering. An
unpopulated `Grants` — `denyAll()` — denies everything, so a missing extractor or a failed
authentication is safe by default rather than by vigilance.

## The empty-list hazard

`hasAll()` with **no** permissions is vacuously `true`. That is the honest answer for a universal
quantifier, and it is a live hazard: a requirement list that accidentally resolved to zero
permissions would authorize everyone. The set algebra stays honest and each declaration site
guards, which means the sites answer the empty case differently **on purpose**:

| site                                            | empty list                                    |
| ----------------------------------------------- | --------------------------------------------- |
| `PermissionSet.hasAll()` / `Grants.hasAll()`    | `true` — set algebra                          |
| `Enforcer.decide()` / `require()` / `enforce()` | denies — far more likely a bug than an intent |
| `RequirementsBuilder.build()`                   | refuses to build at all                       |

"Empty means allow" is therefore only ever safe with a list you wrote **literally**. Anything
derived from configuration, a database, or a lookup should reach an `Enforcer` rather than
`hasAll` directly, because the enforcement layer is where that check already lives.

## Server enforcement (server only)

An `Enforcer` decides whether a request may proceed and says so by throwing. The decision is still
just `Grants.hasAll` — what the enforcer adds is the part that is easy to get wrong exactly once:
the empty-list guard above, fail-closed behaviour for a route nobody declared, and instruments
that tell "a caller overreached" apart from "this service is not enforcing what its author thought
it was".

Two ways to declare what a route needs, and they are the two platform-go ships:

```ts
const enforcer = newEnforcer({
  extract: (c) => c.get("grants"),
  deps: { logger, metrics },
});

// At the registration site — the requirement sits next to the handler it guards.
app.get("/recipes/:id", enforcer.require("recipes.read"), readRecipe);
```

```ts
// Or from a frozen table, installed once. An undeclared route is denied.
const requirements = newRequirements()
  .require("GET /recipes/:id", "recipes.read")
  .markPublic("GET /healthz")
  .build();

const enforcer = newEnforcer({ extract, requirements });
app.use(enforcer.enforce((c) => `${c.req.method} ${c.req.routePath}`));
```

Middleware is `(ctx, next)` — hono- and koa-shaped, generic over the context type, with an express
adapter shown in the `Middleware` doc comment. A denial **throws** `PermissionDeniedError` rather
than writing a response: this package cannot know a consumer's error envelope and should not guess
at one, and routing the denial through the framework's own error hook is what makes it look
identical to a handler that threw the same error itself.

### The table is the stronger of the two

Declaring at the registration site puts the requirement next to the handler, which is where a
reader is most likely to notice its absence — but nothing can detect a route registered with no
guard at all. platform-go says so plainly and stops there, because its HTTP middleware runs before
the mux has matched and a route pattern is not knowable at that point.

TypeScript is not stuck with that. The route table is enumerable at startup, so the check Go lists
as its known gap is one call:

```ts
assertRoutesDeclared(
  app.routes.map((r) => `${r.method} ${r.path}`),
  requirements,
); // throws RouteCoverageError naming every uncovered route
```

Run it at boot and in a test. It reports a rename from both sides — the new name as undeclared, the
old one as stale — which names the mistake far more precisely than either half alone.

### Rolling it out

`auditOnly: true` evaluates and records every decision but denies nothing. Turning enforcement on
across a service that never had it is otherwise a bet that every declaration is right on the first
try: deploy with it, watch `authorization.denials` and `authorization.undeclared` settle to zero,
then remove it. It is the only mode in which an unauthorized request proceeds, which is why it is a
code-level option rather than configuration, and why it announces itself in the log at
construction.

### Watching it

`authorization.checks`, `authorization.denials`, `authorization.missing_grants`,
`authorization.undeclared`, and `authorization.empty_requirements`, each carrying the declared
route key when enforcement was table-driven. Alert on the last three: they mean the wiring is
wrong, not that a caller misbehaved. The key is a declared route pattern, so its cardinality is
bounded by the table — a raw URL path is not, and is never used as a label.

## Policy resolution (server only)

A `Role` grants permissions and may inherit from other roles, transitively. `StaticPolicyResolver`
is the default and the one to reach for until something forces otherwise: no database, no
migrations, no configuration, and it resolves without I/O.

```ts
import { StaticPolicyResolver } from "@primandproper/authorization";

const resolver = new StaticPolicyResolver([
  { name: "reader", permissions: ["recipes.read"] },
  { name: "author", permissions: ["recipes.create"], inherits: ["reader"] },
]);

const permissions = await resolver.permissionsForRoles(session.roles); // once, per session
```

Graduate to a stored policy only when roles themselves must become editable data — when an
operator has to define a role, or change what one grants, without shipping a release. Reassigning
_which_ roles a principal holds does not require it: assignments reference the consumer's own
users and tenants, so they belong to the consumer. **This package owns policy, not assignment.**

Two rules the resolvers share, so backends stay interchangeable:

- **Malformed policy is rejected, never partially applied.** `validateRoles` catches an unnamed
  role, a duplicate, an undefined parent, self-inheritance, and inheritance cycles; the static
  resolver runs it at construction, so a policy mistake fails at startup rather than as a puzzling
  denial later. A policy with more than one cycle names the same one every run.
- **An unknown role contributes nothing rather than throwing.** A principal still assigned a role
  the policy has since dropped loses that authority, not the ability to make requests. Use
  `roles()` to detect that deliberately.

`expandInheritance` is the reference semantics: any backend that expands some other way (in SQL,
say) owes a test asserting it agrees with this function.

## The isomorphic split

- `index.browser.ts` — permission sets, grants, and errors: the checking half.
- `index.node.ts` — the same, plus policy resolution and enforcement.

Resolution is absent from the browser rather than stubbed. It may do I/O and belongs to the
server, which hands the browser the resolved set; a browser that could resolve policy would be a
browser that _holds_ policy. `grantsFromJSON` is the hydration seam, and it is deliberately
tolerant: a payload whose shape drifted costs its holder authority rather than throwing mid-render.

## Turning it off

`allowAll()` is the escape hatch, and it is deliberately a function call at a call site rather
than a configuration flag: turning authorization off should be visible in a diff, not reachable by
setting an environment variable in production.

## Errors

`PermissionDeniedError` says exactly `"permission denied"` and nothing else. Which permission was
missing goes to `missing`, and from there to a span or a log, and stops there — naming it in a
response discloses the permission taxonomy to a caller who just failed to authorize. Serialize
`message` and nothing more. Wrapping with `@primandproper/errors`' `wrap` preserves the code, so
adding context at a boundary does not turn a denial into a 500.

## Not ported

- **A database-backed resolver**, and the cached-resolver wrapper `PolicyInvalidator` exists for.
- **A `config.ts` provider factory** — resolvers and enforcers are constructed directly for now.

Tracked in [#9](https://github.com/primandproper/platform-ts/issues/9).
