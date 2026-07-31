# @primandproper/authorization

## 0.1.0

### Minor Changes

- 6b04184: Add `@primandproper/authorization` — the checking half of platform-go's `authorization`, plus
  static policy resolution.

  The design turns on one seam: resolving role names to permissions may do I/O and happens once per
  session; checking a permission is a map lookup and happens many times per request. Only resolution
  is pluggable, and **checking is synchronous, infallible, and allocation-free** — which is what
  keeps a check inside a loop from becoming N round trips, and what makes the same code usable in a
  React render. The browser therefore runs the identical checks the server does, so the permission
  set gating a handler and the one deciding which controls to draw cannot drift.

  There is deliberately no principal type: enforcement needs authority, not identity. Consumers
  bridge their own session with a `GrantsExtractor`, which is also where a multi-scope model
  collapses into "these sets, OR'd". Sets granting nothing are dropped, so an administrator acting
  on a tenant they do not belong to needs no branch anywhere, and an unpopulated `Grants` denies
  everything.

  `hasAll([])` is vacuously `true` — honest set algebra and a live hazard, since a requirement list
  that accidentally emptied would authorize everyone. The matrix of which declaration sites guard
  the empty case, and how, is documented in one place rather than scattered.

  `StaticPolicyResolver` expands role inheritance transitively, rejects a malformed policy at
  construction rather than applying it partially, and lets an unknown role contribute nothing rather
  than throwing — so a principal assigned a since-deleted role loses that authority, not the ability
  to make requests.

  Server enforcement middleware, a database-backed resolver, and a provider factory are not included
  yet; #9 stays open for them.
