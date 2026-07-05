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
