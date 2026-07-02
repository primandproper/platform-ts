# @primandproper/database

Server-only instrumented database pools: a thin observability + lifecycle layer over a driver pool,
for Drizzle / Kysely / raw SQL. A **narrow** port of platform-go's `database`.

## Scope

The TS ecosystem's query builders (Drizzle, Kysely) and Prisma own connection management, so this is
deliberately a narrow slice — **no query-executor inheritance, no migrations**. It provides:

- **Config + DSN builders** (`postgres` / `mysql` / `sqlite`), matching platform-go's defaults.
- An **instrumented client** (`DatabaseClient`) over a `QueryablePool` seam: spans on queries,
  ping-with-retry readiness, lifecycle, and an injectable clock.
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
