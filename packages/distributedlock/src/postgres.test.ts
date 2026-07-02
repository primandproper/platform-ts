import type { QueryResult, QueryablePool } from "@primandproper/database";
import { describe, expect, it } from "vitest";

import { PostgresDistributedLock } from "./index.js";

interface Call {
  text: string;
  params: readonly unknown[] | undefined;
}

type FakePool = QueryablePool & { calls: Call[] };

function fakePool(responder: (text: string) => QueryResult): FakePool {
  const calls: Call[] = [];
  return {
    calls,
    query(text, params): Promise<QueryResult> {
      calls.push({ text, params });
      return Promise.resolve(responder(text));
    },
    end: () => Promise.resolve(),
  };
}

/** Grants acquisition (INSERT returns a row) and reports one affected row for writes. */
function granting(text: string): QueryResult {
  if (text.startsWith("INSERT")) return { rows: [{ token: "t" }] };
  if (text.startsWith("UPDATE")) return { rows: [{ lock_key: "job" }] };
  if (text.startsWith("DELETE")) return { rows: [], rowCount: 1 };
  return { rows: [{ ok: 1 }] };
}

const callWith = (pool: FakePool, keyword: string): Call | undefined =>
  pool.calls.find((c) => c.text.startsWith(keyword));

describe("PostgresDistributedLock", () => {
  it("acquires by upsert and threads the token through release", async () => {
    const pool = fakePool(granting);
    const lock = new PostgresDistributedLock({ pool });

    const held = await lock.acquire("job", { ttlMs: 5000 });
    expect(held).toBeDefined();

    const insert = callWith(pool, "INSERT");
    expect(insert?.params?.[0]).toBe("job");
    expect(insert?.params?.[2]).toBe(5000);
    const token = insert?.params?.[1];
    expect(typeof token).toBe("string");

    await held?.release();
    const del = callWith(pool, "DELETE");
    expect(del?.params).toStrictEqual(["job", token]);
  });

  it("returns undefined under contention", async () => {
    const pool = fakePool((text) =>
      text.startsWith("INSERT") ? { rows: [] } : { rows: [] },
    );
    const lock = new PostgresDistributedLock({ pool });
    await expect(lock.acquire("job")).resolves.toBeUndefined();
  });

  it("refreshes with the same token and a new ttl", async () => {
    const pool = fakePool(granting);
    const lock = new PostgresDistributedLock({ pool });
    const held = await lock.acquire("job", { ttlMs: 1000 });
    const token = callWith(pool, "INSERT")?.params?.[1];

    await held?.refresh(2000);
    const update = callWith(pool, "UPDATE");
    expect(update?.params).toStrictEqual(["job", token, 2000]);
  });

  it("falls back to the default ttl when none is given", async () => {
    const pool = fakePool(granting);
    await new PostgresDistributedLock({ pool, defaultTtlMs: 12345 }).acquire("job");
    expect(callWith(pool, "INSERT")?.params?.[2]).toBe(12345);
  });

  it("pings with SELECT 1", async () => {
    const pool = fakePool(granting);
    await new PostgresDistributedLock({ pool }).ping();
    expect(pool.calls.some((c) => c.text === "SELECT 1")).toBe(true);
  });

  it("creates the lock table via ensureSchema", async () => {
    const pool = fakePool(granting);
    await new PostgresDistributedLock({ pool, table: "locks" }).ensureSchema();
    expect(callWith(pool, "CREATE TABLE IF NOT EXISTS locks")).toBeDefined();
  });

  it("rejects an unsafe table name", () => {
    const pool = fakePool(granting);
    expect(
      () => new PostgresDistributedLock({ pool, table: "locks; DROP TABLE x" }),
    ).toThrow();
  });
});
