import type { Logger } from "@primandproper/observability";
import { describe, expect, it, vi } from "vitest";

import {
  mysqlPool,
  mysqlPoolSettings,
  pgPool,
  pgPoolSettings,
  postgresKeyValue,
  postgresUri,
  mysqlDsn,
  provideDatabase,
  readConnectionString,
  sqlitePath,
  sqlitePool,
  writeConnectionString,
  DatabaseConfigSchema,
  type PooledConnection,
  type Queryable,
  type QueryablePool,
  type QueryResult,
} from "./index.js";

interface ProbePool extends QueryablePool {
  ended: number;
  calls: () => number;
}

/** A fake pool that fails its first `failuresBeforeSuccess` queries, then succeeds. */
function probePool(failuresBeforeSuccess = 0): ProbePool {
  let calls = 0;
  const pool: ProbePool = {
    ended: 0,
    calls: () => calls,
    query(): Promise<QueryResult> {
      calls += 1;
      if (calls <= failuresBeforeSuccess) return Promise.reject(new Error("down"));
      return Promise.resolve({ rows: [{ ok: 1 }] });
    },
    end(): Promise<void> {
      pool.ended += 1;
      return Promise.resolve();
    },
  };
  return pool;
}

const cd = (
  over: Record<string, unknown> = {},
): ReturnType<typeof DatabaseConfigSchema.parse>["read"] =>
  DatabaseConfigSchema.parse({ read: over }).read;

/** A logger that records error lines so LC-13's readiness/close paths can be asserted. */
function recordingLogger(): {
  logger: Logger;
  errors: { msg: string; err: unknown; values?: unknown }[];
} {
  const errors: { msg: string; err: unknown; values?: unknown }[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (msg, err, values) => errors.push({ msg, err, values }),
    with: () => logger,
    child: () => logger,
    withSpan: () => logger,
  };
  return { logger, errors };
}

interface TxPool extends QueryablePool {
  /** Every statement issued on a pinned connection, in order. */
  statements: string[];
  checkouts: number;
  releases: number;
}

/** A pool that pins a connection and records the transaction's statements and lifecycle. */
function txPool(failOn: (text: string) => Error | undefined = () => undefined): TxPool {
  const pool: TxPool = {
    statements: [],
    checkouts: 0,
    releases: 0,
    query: () => Promise.resolve({ rows: [] }),
    end: () => Promise.resolve(),
    connect(): Promise<PooledConnection> {
      pool.checkouts += 1;
      let released = false;
      return Promise.resolve({
        query(text): Promise<QueryResult> {
          pool.statements.push(text);
          const failure = failOn(text);
          return failure ? Promise.reject(failure) : Promise.resolve({ rows: [] });
        },
        release(): void {
          if (released) return;
          released = true;
          pool.releases += 1;
        },
      });
    },
  };
  return pool;
}

describe("config", () => {
  it("applies the documented defaults", () => {
    const cfg = DatabaseConfigSchema.parse({ read: {} });
    expect(cfg).toMatchObject({
      provider: "postgres",
      maxIdleConns: 5,
      maxOpenConns: 7,
      connMaxLifetimeMs: 30 * 60 * 1000,
      maxPingAttempts: 0,
      pingWaitPeriodMs: 1000,
    });
  });

  it("builds a postgres URI, adding sslmode only when SSL is disabled", () => {
    const details = cd({
      username: "u",
      password: "p@s",
      database: "db",
      host: "h",
      port: 5432,
    });
    expect(postgresUri(details)).toBe("postgres://u:p%40s@h:5432/db");
    expect(postgresUri({ ...details, disableSSL: true })).toBe(
      "postgres://u:p%40s@h:5432/db?sslmode=disable",
    );
  });

  it("builds the key=value, mysql, and sqlite forms", () => {
    const details = cd({
      username: "u",
      password: "p",
      database: "db",
      host: "h",
      port: 3306,
    });
    expect(postgresKeyValue(details)).toBe(
      "user=u password=p database=db host=h port=3306",
    );
    // DB-2: a `mysql://` URI (with percent-encoded credentials), not Go's `@tcp(...)` DSN.
    expect(mysqlDsn(details)).toBe("mysql://u:p@h:3306/db");
    expect(mysqlDsn({ ...details, password: "p@s:w/d" })).toBe(
      "mysql://u:p%40s%3Aw%2Fd@h:3306/db",
    );
    expect(sqlitePath({ ...details, database: "/tmp/app.db" })).toBe("/tmp/app.db");
  });

  it("DB-3: escapes/encodes special characters in DSN components", () => {
    const details = cd({
      username: "u",
      password: "p@ss word",
      database: "my db",
      host: "h",
      port: 5432,
    });
    // libpq key=value: a value with a space (or quote/backslash) is single-quoted, not left bare
    // — otherwise the DSN truncates at the space.
    expect(postgresKeyValue(details)).toBe(
      "user=u password='p@ss word' database='my db' host=h port=5432",
    );
    expect(postgresKeyValue({ ...details, password: "a'b\\c" })).toContain(
      "password='a\\'b\\\\c'",
    );
    // URI forms percent-encode the database segment too, not just the credentials.
    expect(postgresUri(details)).toBe("postgres://u:p%40ss%20word@h:5432/my%20db");
    expect(mysqlDsn(details)).toBe("mysql://u:p%40ss%20word@h:5432/my%20db");
  });

  it("derives connection strings per provider and falls back write→read", () => {
    const cfg = DatabaseConfigSchema.parse({
      provider: "mysql",
      read: { username: "u", password: "p", database: "db", host: "h", port: 3306 },
    });
    expect(readConnectionString(cfg)).toBe("mysql://u:p@h:3306/db");
    expect(writeConnectionString(cfg)).toBe(readConnectionString(cfg));
  });

  // DB-1: pool config maps to real driver options instead of being parsed and discarded.
  it("maps pool config onto pg and mysql2 pool options", () => {
    const cfg = DatabaseConfigSchema.parse({
      read: { database: "db" },
      maxOpenConns: 12,
      maxIdleConns: 4,
      connMaxLifetimeMs: 90_000,
    });
    expect(pgPoolSettings(cfg)).toStrictEqual({ max: 12, maxLifetimeSeconds: 90 });
    expect(mysqlPoolSettings(cfg)).toStrictEqual({ connectionLimit: 12, maxIdle: 4 });
  });
});

describe("provideDatabase", () => {
  const config = { provider: "sqlite", read: { database: ":memory:" } } as const;

  it("uses the injected clock for currentTime", () => {
    const now = new Date("2026-06-30T00:00:00.000Z");
    const client = provideDatabase(config, { read: probePool() }, { now: () => now });
    expect(client.currentTime()).toBe(now);
  });

  it("shares the write pool with the read pool when only one is given", async () => {
    const read = probePool();
    const client = provideDatabase(config, { read });
    expect(client.writePool).toBe(client.readPool);
    await client.close();
    expect(read.ended).toBe(1);
  });

  it("closes both distinct pools", async () => {
    const read = probePool();
    const write = probePool();
    await provideDatabase(config, { read, write }).close();
    expect(read.ended).toBe(1);
    expect(write.ended).toBe(1);
  });

  // LC-13: a failing read-pool end() must not skip the write pool; the failure is logged + surfaced.
  it("drains the write pool even when the read pool's end() rejects, then surfaces the error", async () => {
    const boom = new Error("read drain failed");
    const read = probePool();
    read.end = () => Promise.reject(boom);
    const write = probePool();
    const { logger, errors } = recordingLogger();

    const client = provideDatabase(config, { read, write }, { logger });
    await expect(client.close()).rejects.toBe(boom);

    expect(write.ended).toBe(1); // write pool still drained despite the read failure
    expect(errors.map((e) => e.err)).toContain(boom);
  });

  it("reports ready when the ping succeeds", async () => {
    const client = provideDatabase(config, { read: probePool() });
    await expect(client.isReady()).resolves.toBe(true);
  });

  // DB-3: DatabaseNotReadyError is no longer an exported-but-never-thrown error.
  it("ensureReady resolves when ready and rejects with DatabaseNotReadyError otherwise", async () => {
    const ready = provideDatabase(config, { read: probePool() });
    await expect(ready.ensureReady()).resolves.toBeUndefined();

    const down = provideDatabase(config, { read: probePool(Infinity) });
    await expect(down.ensureReady()).rejects.toMatchObject({
      code: "database/not-ready",
    });
  });

  it("reports not ready, without waiting, when pings fail and no retries are configured", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const client = provideDatabase(config, { read: probePool(Infinity) }, { sleep });
    await expect(client.isReady()).resolves.toBe(false);
    expect(sleep).not.toHaveBeenCalled();
  });

  // LC-13: a readiness failure logs the driver error at error level, not a bare debug line.
  it("logs the ping failure cause at error level when it gives up", async () => {
    const { logger, errors } = recordingLogger();
    const client = provideDatabase(config, { read: probePool(Infinity) }, { logger });

    await expect(client.isReady()).resolves.toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.msg).toMatch(/ping failed for read/);
    expect((errors[0]?.err as Error).message).toBe("down");
    expect(errors[0]?.values).toMatchObject({ connection: "read" });
  });

  it("retries the ping up to maxPingAttempts before succeeding", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const read = probePool(2);
    const client = provideDatabase(
      { ...config, maxPingAttempts: 2 },
      { read },
      { sleep },
    );
    await expect(client.isReady()).resolves.toBe(true);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(read.calls()).toBe(3);
  });

  it("is not ready when a distinct write pool stays down", async () => {
    const client = provideDatabase(config, {
      read: probePool(),
      write: probePool(Infinity),
    });
    await expect(client.isReady()).resolves.toBe(false);
  });

  it("instruments and returns query rows", async () => {
    const client = provideDatabase(config, { read: probePool() });
    const result = await client.query(client.readPool, "SELECT 1");
    expect(result.rows).toStrictEqual([{ ok: 1 }]);
  });
});

describe("adapters", () => {
  it("pgPool normalizes rows and rowCount", async () => {
    const adapted = pgPool({
      query: () => Promise.resolve({ rows: [{ id: 1 }], rowCount: 1 }),
      end: () => Promise.resolve(),
    });
    await expect(adapted.query("SELECT 1")).resolves.toStrictEqual({
      rows: [{ id: 1 }],
      rowCount: 1,
    });
  });

  it("mysqlPool unwraps the rows tuple and maps a header to rowCount", async () => {
    const selectPool = mysqlPool({
      query: () => Promise.resolve([[{ id: 1 }], []]),
      end: () => Promise.resolve(),
    });
    await expect(selectPool.query("SELECT 1")).resolves.toStrictEqual({
      rows: [{ id: 1 }],
    });

    const writePool = mysqlPool({
      query: () => Promise.resolve([{ affectedRows: 3 }, undefined]),
      end: () => Promise.resolve(),
    });
    await expect(writePool.query("DELETE FROM t")).resolves.toStrictEqual({
      rows: [],
      rowCount: 3,
    });
  });

  it("sqlitePool applies pragmas and routes readers vs writers", async () => {
    const pragmas: string[] = [];
    const adapted = sqlitePool({
      prepare: (sql: string) => ({
        reader: sql.startsWith("SELECT"),
        all: () => [{ n: 1 }],
        run: () => ({ changes: 2 }),
      }),
      pragma: (source: string) => {
        pragmas.push(source);
        return undefined;
      },
      close: () => undefined,
    });

    expect(pragmas).toStrictEqual(["journal_mode = WAL", "foreign_keys = ON"]);
    await expect(adapted.query("SELECT 1")).resolves.toStrictEqual({ rows: [{ n: 1 }] });
    await expect(adapted.query("INSERT INTO t VALUES (1)")).resolves.toStrictEqual({
      rows: [],
      rowCount: 2,
    });
  });

  it("DB-3: sqlitePool routes a reader-absent statement to run(), not all()", async () => {
    let allCalls = 0;
    const adapted = sqlitePool(
      {
        // A write statement whose `reader` is absent (per the seam contract). all() would throw
        // in better-sqlite3 ("does not return data"); it must go to run().
        prepare: () => ({
          all: () => {
            allCalls += 1;
            throw new Error("all() called on a non-reader statement");
          },
          run: () => ({ changes: 4 }),
        }),
        pragma: () => undefined,
        close: () => undefined,
      },
      { applyPragmas: false },
    );
    await expect(adapted.query("INSERT INTO t VALUES (1)")).resolves.toStrictEqual({
      rows: [],
      rowCount: 4,
    });
    expect(allCalls).toBe(0);
  });

  it("DB-3: sqlitePool rejects (does not synchronously throw) when prepare fails", async () => {
    const adapted = sqlitePool(
      {
        prepare: () => {
          throw new Error("syntax error");
        },
        pragma: () => undefined,
        close: () => undefined,
      },
      { applyPragmas: false },
    );
    // A synchronous throw from prepare would escape the Promise-typed method; assert it rejects.
    await expect(adapted.query("NOT SQL")).rejects.toThrow(/syntax error/);
  });
});

describe("withTransaction", () => {
  const config = { provider: "postgres", read: { database: "db" } } as const;

  const client = (
    write: QueryablePool,
    deps: Parameters<typeof provideDatabase>[2] = {},
  ): ReturnType<typeof provideDatabase> =>
    provideDatabase(config, { read: probePool(), write }, deps);

  it("wraps the callback in BEGIN/COMMIT and returns its value", async () => {
    const write = txPool();
    const db = client(write);

    await expect(
      db.withTransaction(async (q) => {
        await q.query("INSERT INTO t VALUES ($1)", [1]);
        return "ok";
      }),
    ).resolves.toBe("ok");

    expect(write.statements).toStrictEqual([
      "BEGIN",
      "INSERT INTO t VALUES ($1)",
      "COMMIT",
    ]);
  });

  it("rolls back and re-throws the callback's error unchanged", async () => {
    const write = txPool();
    const boom = new Error("callback failed");

    await expect(
      client(write).withTransaction(async (q) => {
        await q.query("INSERT INTO t VALUES ($1)", [1]);
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(write.statements).toStrictEqual([
      "BEGIN",
      "INSERT INTO t VALUES ($1)",
      "ROLLBACK",
    ]);
  });

  // A transaction on a read replica either errors or silently discards its writes, so the read
  // pool must not be touched even when it is the one that was configured first.
  it("runs on the write pool, never the read pool", async () => {
    const read = probePool();
    const write = txPool();
    const db = provideDatabase(config, { read, write });

    await db.withTransaction(async (q) => {
      await q.query("UPDATE t SET n = 1");
    });

    expect(write.checkouts).toBe(1);
    expect(read.calls()).toBe(0);
  });

  it("releases the connection on commit, on rollback, and when BEGIN itself fails", async () => {
    const committed = txPool();
    await client(committed).withTransaction(async () => undefined);
    expect(committed).toMatchObject({ checkouts: 1, releases: 1 });

    const rolledBack = txPool();
    await expect(
      client(rolledBack).withTransaction(() => Promise.reject(new Error("no"))),
    ).rejects.toThrow("no");
    expect(rolledBack).toMatchObject({ checkouts: 1, releases: 1 });

    // BEGIN failing means there is no transaction to roll back, but there is still a connection
    // checked out — the case a `finally`-less implementation leaks.
    const cannotBegin = txPool((text) =>
      text === "BEGIN" ? new Error("cannot begin") : undefined,
    );
    await expect(
      client(cannotBegin).withTransaction(async () => undefined),
    ).rejects.toThrow("cannot begin");
    expect(cannotBegin.statements).toStrictEqual(["BEGIN"]);
    expect(cannotBegin).toMatchObject({ checkouts: 1, releases: 1 });
  });

  it("leaks no connection across many sequential transactions, half of which fail", async () => {
    const write = txPool();
    const db = client(write);

    for (let i = 0; i < 100; i += 1) {
      const attempt = db.withTransaction(async (q) => {
        await q.query("SELECT 1");
        if (i % 2 === 0) throw new Error(`failure ${String(i)}`);
      });
      if (i % 2 === 0) await expect(attempt).rejects.toThrow(`failure ${String(i)}`);
      else await attempt;
    }

    expect(write.checkouts).toBe(100);
    expect(write.releases).toBe(100);
  });

  // The error that caused the rollback is the diagnosis; the cleanup failure is a footnote. Losing
  // the former to report the latter is the bug this guards.
  it("preserves the original error when the rollback itself fails, and logs the rollback", async () => {
    const write = txPool((text) =>
      text === "ROLLBACK" ? new Error("connection reset") : undefined,
    );
    const { logger, errors } = recordingLogger();
    const boom = new Error("callback failed");

    await expect(
      client(write, { logger }).withTransaction(() => Promise.reject(boom)),
    ).rejects.toBe(boom);

    expect(write.releases).toBe(1);
    const rollbackLine = errors.find((e) => e.msg === "rolling back transaction");
    expect((rollbackLine?.err as Error).message).toBe("connection reset");
    expect(rollbackLine?.values).toMatchObject({ rollbackCause: "callback failed" });
  });

  // A failed commit leaves the outcome unknown, which is a different fact from "the callback threw"
  // — and the driver has already ended the transaction, so a rollback would only raise a spurious
  // "no transaction in progress".
  it("reports a failed commit as TransactionCommitError and attempts no rollback", async () => {
    const write = txPool((text) =>
      text === "COMMIT" ? new Error("deadlock detected") : undefined,
    );

    await expect(
      client(write).withTransaction(async () => "value"),
    ).rejects.toMatchObject({
      code: "database/commit-failed",
      cause: { message: "deadlock detected" },
    });

    expect(write.statements).toStrictEqual(["BEGIN", "COMMIT"]);
    expect(write.releases).toBe(1);
  });

  it("refuses a pool that cannot pin a connection", async () => {
    // probePool has no connect(); spreading statements across arbitrary pooled connections would
    // look like it worked, so this fails loudly instead.
    await expect(
      client(probePool()).withTransaction(async () => undefined),
    ).rejects.toMatchObject({ code: "database/transactions-unsupported" });
  });

  it("hands the callback a bare Queryable with no lifecycle surface", async () => {
    const write = txPool();
    let received: Queryable | undefined;
    await client(write).withTransaction(async (q) => {
      received = q;
    });

    expect(received).toBeDefined();
    expect("release" in received!).toBe(false);
    expect("end" in received!).toBe(false);
    expect("connect" in received!).toBe(false);
  });

  it("honours a dialect-specific begin statement", async () => {
    const write = txPool();
    await client(write, { beginStatement: "BEGIN IMMEDIATE" }).withTransaction(
      async () => undefined,
    );
    expect(write.statements[0]).toBe("BEGIN IMMEDIATE");
  });

  it("instruments statements issued inside the transaction", async () => {
    const write = txPool();
    const db = client(write);
    const rows = await db.withTransaction((q) => db.query(q, "SELECT 1"));
    expect(rows).toStrictEqual({ rows: [] });
    expect(write.statements).toStrictEqual(["BEGIN", "SELECT 1", "COMMIT"]);
  });

  describe("nesting", () => {
    it("refuses to nest on the same client, and still releases the outer connection", async () => {
      const write = txPool();
      const db = client(write);

      await expect(
        db.withTransaction(async () => {
          await db.withTransaction(async () => undefined);
        }),
      ).rejects.toMatchObject({ code: "database/nested-transaction" });

      // The inner call never checked a connection out; the outer one rolled back and released.
      expect(write).toMatchObject({ checkouts: 1, releases: 1 });
      expect(write.statements).toStrictEqual(["BEGIN", "ROLLBACK"]);
    });

    it("detects a nest that happens after an await", async () => {
      const write = txPool();
      const db = client(write);

      await expect(
        db.withTransaction(async (q) => {
          await q.query("SELECT 1");
          await db.withTransaction(async () => undefined);
        }),
      ).rejects.toMatchObject({ code: "database/nested-transaction" });
    });

    // The reason detection is async-context-scoped rather than a boolean on the client: two
    // requests transacting at once are the normal case, not a nesting violation.
    it("allows genuinely concurrent transactions on the same client", async () => {
      const write = txPool();
      const db = client(write);
      let releaseFirst!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      const first = db.withTransaction(async (q) => {
        await gate;
        await q.query("first");
        return 1;
      });
      const second = db.withTransaction(async (q) => {
        await q.query("second");
        releaseFirst();
        return 2;
      });

      await expect(Promise.all([first, second])).resolves.toStrictEqual([1, 2]);
      expect(write).toMatchObject({ checkouts: 2, releases: 2 });
    });

    // Two databases share no commit. Refusing this would not make the write atomic, it would only
    // stop the caller expressing what they already have to reason about themselves.
    it("allows a different client's transaction inside this one", async () => {
      const outer = txPool();
      const inner = txPool();
      const outerDb = client(outer);
      const innerDb = client(inner);

      await outerDb.withTransaction(async () => {
        await innerDb.withTransaction(async (q) => {
          await q.query("INSERT INTO other VALUES (1)");
        });
      });

      expect(outer.statements).toStrictEqual(["BEGIN", "COMMIT"]);
      expect(inner.statements).toStrictEqual([
        "BEGIN",
        "INSERT INTO other VALUES (1)",
        "COMMIT",
      ]);
    });
  });
});

/**
 * A driver stand-in wired through its real adapter, so the conformance suite below exercises the
 * adapter's own checkout/release path rather than a hand-written pool.
 */
interface DriverProbe {
  pool: QueryablePool;
  statements: string[];
  /** Connections checked out but not yet released. */
  open: () => number;
}

function pgProbe(): DriverProbe {
  const statements: string[] = [];
  let open = 0;
  const pool = pgPool({
    query: (text) => {
      statements.push(text);
      return Promise.resolve({ rows: [], rowCount: null });
    },
    connect: () => {
      open += 1;
      return Promise.resolve({
        query: (text) => {
          statements.push(text);
          return Promise.resolve({ rows: [], rowCount: null });
        },
        release: () => {
          open -= 1;
        },
      });
    },
    end: () => Promise.resolve(),
  });
  return { pool, statements, open: () => open };
}

function mysqlProbe(): DriverProbe {
  const statements: string[] = [];
  let open = 0;
  const pool = mysqlPool({
    query: (sql) => {
      statements.push(sql);
      return Promise.resolve([[], undefined]);
    },
    getConnection: () => {
      open += 1;
      return Promise.resolve({
        query: (sql) => {
          statements.push(sql);
          return Promise.resolve([[], undefined]);
        },
        release: () => {
          open -= 1;
        },
      });
    },
    end: () => Promise.resolve(),
  });
  return { pool, statements, open: () => open };
}

function sqliteProbe(): DriverProbe {
  const statements: string[] = [];
  const pool = sqlitePool(
    {
      prepare: (sql: string) => ({
        reader: sql.startsWith("SELECT"),
        all: () => {
          statements.push(sql);
          return [];
        },
        run: () => {
          statements.push(sql);
          return { changes: 0 };
        },
      }),
      pragma: () => undefined,
      close: () => undefined,
    },
    { applyPragmas: false },
  );
  // better-sqlite3 has one connection; the adapter's checkout is a lock, not a pool slot, so
  // there is no driver-side counter to read. Leak-freedom is asserted below by the fact that a
  // hundred sequential transactions all complete rather than deadlocking on a leaked slot.
  return { pool, statements, open: () => 0 };
}

/**
 * Provider-agnostic transaction conformance. Running the same assertions through each adapter
 * proves `withTransaction` is dialect-independent, and that every adapter's `connect()` really
 * pins a connection and gives it back.
 */
describe.each([
  ["postgres", pgProbe],
  ["mysql", mysqlProbe],
  ["sqlite", sqliteProbe],
] as const)("withTransaction conformance: %s", (provider, makeProbe) => {
  const db = (probe: DriverProbe): ReturnType<typeof provideDatabase> =>
    provideDatabase({ provider, read: { database: "db" } }, { read: probe.pool });

  it("commits the callback's statements", async () => {
    const probe = makeProbe();
    await db(probe).withTransaction(async (q) => {
      await q.query("INSERT INTO t VALUES (1)");
    });
    expect(probe.statements).toStrictEqual([
      "BEGIN",
      "INSERT INTO t VALUES (1)",
      "COMMIT",
    ]);
    expect(probe.open()).toBe(0);
  });

  it("rolls back and re-throws", async () => {
    const probe = makeProbe();
    const boom = new Error("nope");
    await expect(
      db(probe).withTransaction(async (q) => {
        await q.query("INSERT INTO t VALUES (1)");
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(probe.statements).toStrictEqual([
      "BEGIN",
      "INSERT INTO t VALUES (1)",
      "ROLLBACK",
    ]);
    expect(probe.open()).toBe(0);
  });

  it("holds nothing across a hundred sequential transactions", async () => {
    const probe = makeProbe();
    const client = db(probe);
    for (let i = 0; i < 100; i += 1) {
      await client.withTransaction(async (q) => {
        await q.query("SELECT 1");
      });
    }
    expect(probe.open()).toBe(0);
    expect(probe.statements).toHaveLength(300);
  });
});

// sqlite's semantics differ enough to be worth asserting rather than assuming: one connection, no
// nested transactions, and no error if a second BEGIN lands inside the first one's scope — it just
// silently joins it, and the first COMMIT commits both.
describe("sqlite transaction semantics", () => {
  it("serializes concurrent transactions instead of interleaving them", async () => {
    const probe = sqliteProbe();
    const client = provideDatabase(
      { provider: "sqlite", read: { database: ":memory:" } },
      { read: probe.pool },
    );

    const runs = ["a", "b", "c"].map((name) =>
      client.withTransaction(async (q) => {
        await q.query(`INSERT INTO t VALUES ('${name}')`);
        // Yield twice, so an unserialized implementation would certainly interleave here.
        await Promise.resolve();
        await q.query(`UPDATE t SET n = 1 WHERE v = '${name}'`);
      }),
    );
    await Promise.all(runs);

    expect(probe.statements).toStrictEqual([
      "BEGIN",
      "INSERT INTO t VALUES ('a')",
      "UPDATE t SET n = 1 WHERE v = 'a'",
      "COMMIT",
      "BEGIN",
      "INSERT INTO t VALUES ('b')",
      "UPDATE t SET n = 1 WHERE v = 'b'",
      "COMMIT",
      "BEGIN",
      "INSERT INTO t VALUES ('c')",
      "UPDATE t SET n = 1 WHERE v = 'c'",
      "COMMIT",
    ]);
  });

  it("hands the lock back when a transaction fails, so the next one is not blocked", async () => {
    const probe = sqliteProbe();
    const client = provideDatabase(
      { provider: "sqlite", read: { database: ":memory:" } },
      { read: probe.pool },
    );

    await expect(
      client.withTransaction(() => Promise.reject(new Error("first failed"))),
    ).rejects.toThrow("first failed");
    await expect(
      client.withTransaction(async (q) => {
        await q.query("SELECT 1");
        return "second ran";
      }),
    ).resolves.toBe("second ran");
  });
});
