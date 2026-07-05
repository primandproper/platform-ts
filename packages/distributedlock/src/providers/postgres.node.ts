import { randomUUID } from "node:crypto";

import type { QueryablePool } from "@primandproper/database";
import { wrap } from "@primandproper/errors";
import {
  makeObserver,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type { AcquireOptions, DistributedLock, Lock } from "../distributedlock.js";

import { lockInstruments, type LockInstruments } from "./support.js";

const o11yName = "distributedlock";
const DEFAULT_TTL_MS = 30_000;
const DEFAULT_TABLE = "distributed_locks";
// Table names cannot be parameterized, so restrict to a plain identifier to keep SQL injection-safe.
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface PostgresDistributedLockOptions {
  /** A pool from `@primandproper/database` (or any {@link QueryablePool}) over the lock database. */
  pool: QueryablePool;
  /** The lock table name (a plain identifier). Defaults to `distributed_locks`. */
  table?: string;
  /** Lease duration when {@link AcquireOptions.ttlMs} is omitted, in milliseconds. */
  defaultTtlMs?: number;
}

/**
 * Node-only provider backed by a Postgres lock table. Each key is a row carrying the holder's
 * `token` and an `expires_at`; the database's own clock decides expiry, mirroring how the redis
 * provider leans on redis's clock. Acquisition is an atomic upsert that only takes over a row whose
 * lease has lapsed; release and refresh are token-guarded, so a {@link Lock} only ever frees or
 * extends a lease this caller still owns. Contention is `undefined`, not a throw.
 *
 * This deliberately uses a lease table rather than `pg_advisory_lock`: advisory locks are bound to a
 * single session and have no TTL, so they cannot honor this interface's ttl/refresh semantics over a
 * connection pool.
 */
export class PostgresDistributedLock implements DistributedLock {
  readonly #pool: QueryablePool;
  readonly #table: string;
  readonly #defaultTtlMs: number;
  readonly #observer: Observer;
  readonly #instruments: LockInstruments;
  readonly #acquireSql: string;
  readonly #releaseSql: string;
  readonly #refreshSql: string;

  constructor(options: PostgresDistributedLockOptions, deps: ObservabilityDeps = {}) {
    const table = options.table ?? DEFAULT_TABLE;
    if (!SAFE_IDENTIFIER.test(table)) {
      throw new Error(`invalid lock table name: ${table}`);
    }
    this.#pool = options.pool;
    this.#table = table;
    this.#defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#instruments = lockInstruments(o11yName, deps);
    this.#acquireSql =
      `INSERT INTO ${table} (lock_key, token, expires_at) ` +
      `VALUES ($1, $2, now() + $3 * interval '1 millisecond') ` +
      `ON CONFLICT (lock_key) DO UPDATE SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at ` +
      `WHERE ${table}.expires_at < now() RETURNING token`;
    this.#releaseSql = `DELETE FROM ${table} WHERE lock_key = $1 AND token = $2`;
    this.#refreshSql =
      `UPDATE ${table} SET expires_at = now() + $3 * interval '1 millisecond' ` +
      `WHERE lock_key = $1 AND token = $2 AND expires_at > now() RETURNING lock_key`;
  }

  /** Creates the lock table if it does not exist. Run once at startup. */
  async ensureSchema(): Promise<void> {
    await this.#pool.query(
      `CREATE TABLE IF NOT EXISTS ${this.#table} ` +
        `(lock_key text PRIMARY KEY, token text NOT NULL, expires_at timestamptz NOT NULL)`,
    );
  }

  /**
   * DL-2: deletes every row whose lease has lapsed and returns the count. `acquire` already
   * reclaims a *contended* key's expired row via its upsert, but a key that is acquired once and
   * then abandoned leaves a dead row forever — schedule this periodically (e.g. a cron/interval)
   * to reclaim that residue. Kept a caller-driven maintenance call rather than a per-`acquire`
   * full-table `DELETE`, which would add a table scan to the hot path.
   */
  async cleanupExpired(): Promise<number> {
    return this.#observer.run("cleanup_expired", async (op) => {
      try {
        const result = await this.#pool.query(
          `DELETE FROM ${this.#table} WHERE expires_at < now()`,
        );
        const deleted = result.rowCount ?? 0;
        op.set("deleted", deleted);
        return deleted;
      } catch (err) {
        throw op.error(
          wrap("distributedlock: failed to clean up expired locks on postgres", err),
          "cleaning up expired locks on postgres",
        );
      }
    });
  }

  acquire(key: string, opts: AcquireOptions = {}): Promise<Lock | undefined> {
    return this.#observer.run("acquire", async (op) => {
      op.set("key", key);
      const ttlMs = opts.ttlMs ?? this.#defaultTtlMs;
      const token = randomUUID();

      let rows: unknown[];
      try {
        rows = (await this.#pool.query(this.#acquireSql, [key, token, ttlMs])).rows;
      } catch (err) {
        throw op.error(
          wrap(`distributedlock: failed to acquire ${key} on postgres`, err),
          "acquiring lock on postgres",
        );
      }

      if (rows.length === 0) {
        op.logger().debug("lock is already held");
        this.#instruments.contention.add(1, { operation: "acquire" });
        return undefined;
      }

      return this.#makeLock(key, token, ttlMs);
    });
  }

  async ping(): Promise<void> {
    try {
      await this.#pool.query("SELECT 1");
    } catch (err) {
      throw wrap("distributedlock: postgres ping failed", err);
    }
  }

  /**
   * No-op: the pool is injected and owned by the caller (it typically outlives this lock and is
   * shared with the rest of the app), so its lifecycle — including draining — is the caller's.
   */
  close(): Promise<void> {
    return Promise.resolve();
  }

  #makeLock(key: string, token: string, ttlMs: number): Lock {
    const release = (): Promise<boolean> =>
      this.#observer.run("release", async (op) => {
        op.set("key", key);
        let result;
        try {
          result = await this.#pool.query(this.#releaseSql, [key, token]);
        } catch (err) {
          throw op.error(
            wrap(`distributedlock: failed to release ${key} on postgres`, err),
            "releasing lock on postgres",
          );
        }
        if ((result.rowCount ?? 0) === 0) {
          op.logger().debug("release ignored: lease no longer owned");
          this.#instruments.contention.add(1, { operation: "release" });
          return false;
        }
        return true;
      });

    const refresh = (newTtlMs?: number): Promise<boolean> =>
      this.#observer.run("refresh", async (op) => {
        op.set("key", key);
        let extended: unknown[];
        try {
          extended = (
            await this.#pool.query(this.#refreshSql, [key, token, newTtlMs ?? ttlMs])
          ).rows;
        } catch (err) {
          throw op.error(
            wrap(`distributedlock: failed to refresh ${key} on postgres`, err),
            "refreshing lock on postgres",
          );
        }
        if (extended.length === 0) {
          op.logger().debug("refresh ignored: lease no longer owned");
          this.#instruments.contention.add(1, { operation: "refresh" });
          return false;
        }
        return true;
      });

    return { key, release, refresh };
  }
}
