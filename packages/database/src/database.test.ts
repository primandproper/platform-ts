import { describe, expect, it, vi } from "vitest";

import {
  mysqlPool,
  pgPool,
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
    expect(mysqlDsn(details)).toBe("u:p@tcp(h:3306)/db");
    expect(sqlitePath({ ...details, database: "/tmp/app.db" })).toBe("/tmp/app.db");
  });

  it("derives connection strings per provider and falls back write→read", () => {
    const cfg = DatabaseConfigSchema.parse({
      provider: "mysql",
      read: { username: "u", password: "p", database: "db", host: "h", port: 3306 },
    });
    expect(readConnectionString(cfg)).toBe("u:p@tcp(h:3306)/db");
    expect(writeConnectionString(cfg)).toBe(readConnectionString(cfg));
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

  it("reports ready when the ping succeeds", async () => {
    const client = provideDatabase(config, { read: probePool() });
    await expect(client.isReady()).resolves.toBe(true);
  });

  it("reports not ready, without waiting, when pings fail and no retries are configured", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const client = provideDatabase(config, { read: probePool(Infinity) }, { sleep });
    await expect(client.isReady()).resolves.toBe(false);
    expect(sleep).not.toHaveBeenCalled();
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
});
