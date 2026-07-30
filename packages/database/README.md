# @primandproper/database

Server-only instrumented database pools: a thin observability + lifecycle layer over a driver pool,
for Drizzle / Kysely / raw SQL. A **narrow** port of platform-go's `database`.

## Scope

The TS ecosystem's query builders (Drizzle, Kysely) and Prisma own connection management, so this is
deliberately a narrow slice — **no query-executor inheritance, no migrations**. It provides:

- **Config + DSN builders** (`postgres` / `mysql` / `sqlite`), matching platform-go's defaults.
- An **instrumented client** (`DatabaseClient`) over a `QueryablePool` seam: spans on queries,
  ping-with-retry readiness, lifecycle, and an injectable clock.
- **Transactions** (`withTransaction`) on a pinned write connection.
- **Structural adapters** (`pgPool`, `mysqlPool`, `sqlitePool`) so the package depends on no driver —
  you bring your own `pg` / `mysql2` / `better-sqlite3` instance.

## Usage

```ts
import { Pool } from "pg";
import {
  DatabaseConfigSchema,
  readConnectionString,
  pgPool,
  provideDatabase,
} from "@primandproper/database";

const config = DatabaseConfigSchema.parse({
  provider: "postgres",
  read: { username: "app", password: "secret", database: "app", host: "db", port: 5432 },
});

const raw = new Pool({ connectionString: readConnectionString(config) });
const db = provideDatabase(config, { read: pgPool(raw) }, { logger });

if (!(await db.isReady())) throw new Error("database not ready");

// Hand db.readPool / db.writePool to Drizzle/Kysely, or use the instrumented helper:
const { rows } = await db.query(db.readPool, "SELECT 1");
await db.close();
```

`sqlite` (via `better-sqlite3`) applies WAL journaling and foreign-key enforcement and is inherently
single-writer, matching platform-go.

## Transactions

`withTransaction` runs its callback on **one pinned connection from the write pool**. Resolving
commits; rejecting rolls back and re-throws the original error unchanged.

```ts
const orderId = await db.withTransaction(async (q) => {
  const { rows } = await q.query(
    "INSERT INTO orders (total) VALUES ($1) RETURNING id",
    [99],
  );
  await q.query("INSERT INTO order_events (order_id, kind) VALUES ($1, 'created')", [
    rows[0].id,
  ]);
  return rows[0].id;
});
```

The callback receives a bare `Queryable` — `query` and nothing else. It cannot commit, roll back,
close the pool, or outlive the closure; that lifecycle belongs to `withTransaction`, which acquires
the connection and releases it in a `finally`. `QueryablePool extends Queryable`, so a helper written
against the narrow type takes either:

```ts
// Works with db.readPool, db.writePool, or the transaction's q.
async function findOrder(q: Queryable, id: string) { … }
```

That is the seam the `outbox` port is built on: holding a `Queryable` handed out by
`withTransaction` _means_ you are inside a transaction, so an enqueue cannot escape one by accident.

Behaviour worth knowing:

| situation                      | result                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| callback resolves              | `COMMIT`; its value is returned                                                                        |
| callback rejects               | `ROLLBACK`; the **original** error is re-thrown (a failed rollback is logged, not surfaced)            |
| `COMMIT` fails                 | `TransactionCommitError` (`database/commit-failed`), driver error as `cause`; no rollback is attempted |
| nested on the same client      | `NestedTransactionError` (`database/nested-transaction`) — there are no savepoints                     |
| nested on a _different_ client | allowed; two databases share no commit and this package does not pretend otherwise                     |
| write pool has no `connect()`  | `TransactionsUnsupportedError` (`database/transactions-unsupported`)                                   |

Nesting is detected per async context, so concurrent transactions on one client — the normal case
for a server handling many requests — are unaffected.

Statements inside the callback can still be instrumented: `db.query(q, "…")` accepts the narrow
`Queryable`.

### Dialect notes

`BEGIN` is issued by default, which postgres, mysql, and sqlite all accept. Override it with the
`beginStatement` dep where the default locking mode is wrong — notably sqlite, where
`BEGIN IMMEDIATE` takes the write lock up front instead of failing with `SQLITE_BUSY` when a
deferred transaction tries to upgrade mid-flight:

```ts
const db = provideDatabase(
  config,
  { read: sqlitePool(raw) },
  {
    logger,
    beginStatement: "BEGIN IMMEDIATE",
  },
);
```

`better-sqlite3` has a single connection and no nested transactions — a second `BEGIN` silently
joins the first one's scope, and the first `COMMIT` commits both. `sqlitePool`'s `connect()` is
therefore a write lock rather than a pool slot: concurrent `withTransaction` calls queue in arrival
order instead of interleaving.
