---
"@primandproper/database": minor
---

Add `DatabaseClient.withTransaction(fn)`: several statements on one pinned write connection,
committing when `fn` resolves and rolling back — then re-throwing the original error unchanged —
when it rejects. This is the hard prerequisite for the `outbox` port, whose entire guarantee rests
on the event insert being a statement in the caller's transaction.

`fn` receives a bare `Queryable` (`query` and nothing else), so it cannot commit, roll back, close
the pool, or outlive the closure — lifecycle stays with the method that owns it. `QueryablePool`
now extends `Queryable`, so a helper written against the narrow type accepts a pool or a
transaction, which is what lets `outbox.enqueue` make "holding a `Queryable`" _mean_ "inside a
transaction". `DatabaseClient.query` widened to `Queryable` for the same reason, so statements
inside a transaction are instrumented like any other.

A transaction is a pinned connection rather than a pool, so `QueryablePool` gains an optional
`connect()` and each adapter supplies it — `pool.connect()` for pg, `getConnection()` for mysql,
and a write lock for sqlite, which has one connection and no nested transactions (a second `BEGIN`
would silently join the first one's scope). A pool that cannot pin a connection throws
`TransactionsUnsupportedError` instead of spreading the statements across arbitrary pooled
connections, which is the failure that looks like it worked. The connection is released in a
`finally` — including when `BEGIN`, the callback, the rollback, or the commit failed — since one
leaked connection per transaction exhausts the pool and presents as unrelated latency.

Documented and tested behaviour: a failed rollback is logged rather than replacing the error that
caused it; a failed `COMMIT` raises `TransactionCommitError` (distinct in kind — the outcome is
unknown, not provably absent) and attempts no second rollback; nesting on the same client throws
`NestedTransactionError` rather than flattening two scopes, detected per async context so
concurrent transactions on one client still work, and a different client's transaction may nest.
Covered by a provider-agnostic conformance suite run through the postgres, mysql, and sqlite
adapters.
