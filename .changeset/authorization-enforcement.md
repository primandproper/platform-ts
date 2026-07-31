---
"@primandproper/authorization": minor
---

Add the server enforcement layer: `Enforcer`, a frozen `Requirements` table, and a boot-time route
coverage check.

The checking half already shipped. What was missing was the two rows of the empty-list matrix that
actually do the guarding — until now they described code that did not exist, so a caller building a
requirement list from anything other than a literal had to check it for emptiness itself, which is
precisely the burden an enforcement layer exists to remove.

`Enforcer` decides and says so by throwing. The decision is still `Grants.hasAll`; what the
enforcer adds is the part that is easy to get wrong exactly once. **An empty requirement list
denies** — set algebra says vacuously true, but a guard installed with an empty list is far more
likely a list that came back empty from configuration than an intent to admit everyone, and a route
needing no authorization simply carries no guard. `RequirementsBuilder.build()` refuses outright,
reporting every problem it found rather than the first, because a table assembled from a dozen
feature modules usually has more than one.

Requirements are declared either at the route's registration site (`enforcer.require(...)`) or in a
frozen table consulted by one middleware (`enforcer.enforce(keyOf)`), where **an undeclared key is
denied** — being public is a declaration, never an omission. Middleware is `(ctx, next)`, generic
over the context type; a denial throws `PermissionDeniedError` rather than writing a response,
since this package cannot know a consumer's error envelope and routing the denial through the
framework's own error hook makes it identical to a handler that threw it.

`assertRoutesDeclared` is the piece platform-go could not have. Its HTTP middleware runs before the
mux has matched, so an unguarded route is undetectable there; in TypeScript the route table is
enumerable at startup, so "every registered route either requires permissions or is explicitly
marked public" becomes a fact checked before the first request. It reports a rename from both sides
— the new name undeclared, the old one stale — which names the mistake more precisely than either
half alone.

`auditOnly` records every decision without acting on it, for turning enforcement on across a
service that never had it. Five instruments back it, and three of them (`missing_grants`,
`undeclared`, `empty_requirements`) count wiring bugs rather than misbehaving callers — those are
the ones to alert on.
