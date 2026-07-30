---
"@primandproper/idempotency": minor
---

Add `@primandproper/idempotency`, the port of platform-go's `idempotency`: work runs at most once
per client-supplied key, so a retry of a request whose response was never seen replays the
recorded result instead of charging the card twice.

The manager implements the four-step claim protocol exactly — read, then lock/re-read/claim/
unlock, then run the work **outside** the lock, then record or release. The re-read inside the
lock is what makes it correct, and the work stays outside it because a held lock is a held
resource (the postgres provider holds a transaction), lock leases are shorter than real work, and
a lock leaves no evidence when a process dies mid-execution. Claims carry an owner id, so an
execution that outlived its claim cannot overwrite whoever re-claimed the key —
`idempotency.claims.lost` counts that and is the counter to alert on.

The four outcomes are a discriminated union (`executed` / `replayed` / `in-flight` /
`fingerprint-mismatch`) rather than thrown sentinels: they are expected control flow, and this
matches the repo's optional-over-sentinels stance. Thrown `PlatformError`s are reserved for
genuine failures. Store failure is `fail-closed` by default, `fail-open` opt-in, and — diverging
from platform-go, which applies it to reads only — the policy covers claim writes and lock
failures too, so `fail-open` means what its name says.

The package is isomorphic with a deliberately asymmetric split: the browser entry carries key
minting, fingerprinting, and an `idempotentFetch` wrapper that binds one key to the wrapper (so
building it inside a retry loop is the visible mistake), while the Node entry adds the manager. A
browser has no record store or lock, and a noop stand-in would be idempotency that looks wired up
and guarantees nothing.

Also exports `withLock`, a scoped acquire/run/release helper over `DistributedLock` that reports
contention as a value rather than throwing.
