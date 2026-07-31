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

| site                                         | empty list                                    |
| -------------------------------------------- | --------------------------------------------- |
| `PermissionSet.hasAll()` / `Grants.hasAll()` | `true` — set algebra                          |
| server enforcement middleware                | denies — far more likely a bug than an intent |
| a frozen requirements table                  | refuses to build at all                       |

"Empty means allow" is therefore only ever safe with a list you wrote **literally**. Anything
derived from configuration, a database, or a lookup must be checked for emptiness first. The last
two rows describe the enforcement layer, which is not ported yet — see "Not ported" below — so
today that check is the caller's job.

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
- `index.node.ts` — the same, plus policy resolution.

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

- **Server enforcement** — the middleware that denies an empty requirement list, and the frozen
  requirements table that refuses to build one. TypeScript has a real opportunity here that Go
  lacked: with hono/express/fastify the route table is enumerable at startup, so a boot-time check
  that every registered route either declares permissions or is explicitly marked public is
  achievable.
- **A database-backed resolver**, and the cached-resolver wrapper `PolicyInvalidator` exists for.
- **A `config.ts` provider factory** — resolvers are constructed directly for now.

Tracked in [#9](https://github.com/primandproper/platform-ts/issues/9).
