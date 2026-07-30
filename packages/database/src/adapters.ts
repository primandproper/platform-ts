import type { PooledConnection, QueryablePool, QueryResult } from "./database.js";

/**
 * Adapters that normalize a driver's pool to {@link QueryablePool}. They are structurally typed, so
 * this package depends on no driver: the caller constructs `pg`/`mysql2`/`better-sqlite3` with the
 * connection string from `config.ts` and hands the instance here.
 *
 * Each adapter also supplies {@link QueryablePool.connect}, since a transaction is a pinned
 * connection rather than a pool, and only the driver knows how to check one out.
 */

/** The subset of a `node-postgres` `PoolClient` used here. */
export interface PgClientLike {
  query(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount?: number | null }>;
  release(): void;
}

/** The subset of a `node-postgres` `Pool` used here. */
export interface PgPoolLike {
  query(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount?: number | null }>;
  /** Absent only in a stand-in; a real `pg.Pool` always has it. */
  connect?(): Promise<PgClientLike>;
  end(): Promise<void>;
}

function pgResult(raw: { rows: unknown[]; rowCount?: number | null }): QueryResult {
  const result: QueryResult = { rows: raw.rows };
  if (raw.rowCount != null) result.rowCount = raw.rowCount;
  return result;
}

/** Adapts a `node-postgres` `Pool`. */
export function pgPool(pool: PgPoolLike): QueryablePool {
  const adapted: QueryablePool = {
    async query(text, params): Promise<QueryResult> {
      return pgResult(await pool.query(text, params));
    },
    end: () => pool.end(),
  };
  const connect = pool.connect?.bind(pool);
  if (connect) {
    adapted.connect = async (): Promise<PooledConnection> => {
      const client = await connect();
      let released = false;
      return {
        async query(text, params): Promise<QueryResult> {
          return pgResult(await client.query(text, params));
        },
        // `pg` throws on a double release; guard so a release racing the pool's own error handling
        // cannot turn cleanup into the error the caller sees.
        release(): void {
          if (released) return;
          released = true;
          client.release();
        },
      };
    };
  }
  return adapted;
}

/** The subset of a `mysql2/promise` `PoolConnection` used here. */
export interface MysqlConnectionLike {
  query(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
  release(): void;
}

/** The subset of a `mysql2/promise` `Pool` used here. */
export interface MysqlPoolLike {
  query(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
  /** Absent only in a stand-in; a real `mysql2/promise` `Pool` always has it. */
  getConnection?(): Promise<MysqlConnectionLike>;
  end(): Promise<void>;
}

function mysqlResult(rows: unknown): QueryResult {
  if (Array.isArray(rows)) return { rows };
  const header = rows as { affectedRows?: number };
  const result: QueryResult = { rows: [] };
  if (typeof header.affectedRows === "number") result.rowCount = header.affectedRows;
  return result;
}

/** Adapts a `mysql2/promise` `Pool`. Non-`SELECT` results (a header, not rows) yield empty `rows`. */
export function mysqlPool(pool: MysqlPoolLike): QueryablePool {
  const adapted: QueryablePool = {
    async query(text, params): Promise<QueryResult> {
      const [rows] = await pool.query(text, params);
      return mysqlResult(rows);
    },
    end: () => pool.end(),
  };
  const getConnection = pool.getConnection?.bind(pool);
  if (getConnection) {
    adapted.connect = async (): Promise<PooledConnection> => {
      const connection = await getConnection();
      let released = false;
      return {
        async query(text, params): Promise<QueryResult> {
          const [rows] = await connection.query(text, params);
          return mysqlResult(rows);
        },
        release(): void {
          if (released) return;
          released = true;
          connection.release();
        },
      };
    };
  }
  return adapted;
}

/** The subset of a `better-sqlite3` prepared statement used here. */
export interface SqliteStatementLike {
  /** `true` when the statement returns rows; `false`/absent for writes. */
  reader?: boolean;
  all(...params: readonly unknown[]): unknown[];
  run(...params: readonly unknown[]): { changes: number };
}

/** The subset of a `better-sqlite3` `Database` used here. */
export interface SqliteDatabaseLike {
  prepare(sql: string): SqliteStatementLike;
  pragma(source: string): unknown;
  close(): void;
}

/**
 * Adapts a `better-sqlite3` `Database`. By default applies WAL journaling and foreign-key
 * enforcement, matching platform-go's sqlite client. The connection is inherently single-writer.
 */
export function sqlitePool(
  db: SqliteDatabaseLike,
  options: { applyPragmas?: boolean } = {},
): QueryablePool {
  if (options.applyPragmas !== false) {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
  }
  // `async` so a synchronous `prepare` throw (invalid SQL) rejects the returned promise rather
  // than escaping synchronously from this Promise-typed method.
  const exec = async (
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult> => {
    const statement = db.prepare(text);
    // Only a row-returning statement (`reader === true`: SELECT, or `... RETURNING`) may use
    // `all()`; a write is `reader === false` OR absent per SqliteStatementLike's contract, and
    // calling `all()` on it throws in better-sqlite3. Route by truthiness so absent means write.
    if (statement.reader) {
      return { rows: statement.all(...params) };
    }
    const info = statement.run(...params);
    return { rows: [], rowCount: info.changes };
  };

  // There is one connection, so "check one out" means "take the write lock". Without this a second
  // concurrent transaction would interleave its BEGIN into the first one's scope and commit both at
  // the first COMMIT — sqlite has no nested transactions to catch it. Callers queue instead.
  let tail: Promise<void> = Promise.resolve();

  return {
    query: exec,
    async connect(): Promise<PooledConnection> {
      let handOff!: () => void;
      const held = new Promise<void>((resolve) => {
        handOff = resolve;
      });
      const ahead = tail;
      // Claim the slot synchronously, before the first await, so concurrent callers queue in
      // arrival order rather than all racing on the same value of `tail`.
      tail = ahead.then(() => held);
      await ahead;

      let released = false;
      return {
        query: exec,
        release(): void {
          if (released) return;
          released = true;
          handOff();
        },
      };
    },
    end(): Promise<void> {
      db.close();
      return Promise.resolve();
    },
  };
}
