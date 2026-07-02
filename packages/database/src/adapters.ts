import type { QueryablePool, QueryResult } from "./database.js";

/**
 * Adapters that normalize a driver's pool to {@link QueryablePool}. They are structurally typed, so
 * this package depends on no driver: the caller constructs `pg`/`mysql2`/`better-sqlite3` with the
 * connection string from `config.ts` and hands the instance here.
 */

/** The subset of a `node-postgres` `Pool` used here. */
export interface PgPoolLike {
  query(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount?: number | null }>;
  end(): Promise<void>;
}

/** Adapts a `node-postgres` `Pool`. */
export function pgPool(pool: PgPoolLike): QueryablePool {
  return {
    async query(text, params): Promise<QueryResult> {
      const raw = await pool.query(text, params);
      const result: QueryResult = { rows: raw.rows };
      if (raw.rowCount != null) result.rowCount = raw.rowCount;
      return result;
    },
    end: () => pool.end(),
  };
}

/** The subset of a `mysql2/promise` `Pool` used here. */
export interface MysqlPoolLike {
  query(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
}

/** Adapts a `mysql2/promise` `Pool`. Non-`SELECT` results (a header, not rows) yield empty `rows`. */
export function mysqlPool(pool: MysqlPoolLike): QueryablePool {
  return {
    async query(text, params): Promise<QueryResult> {
      const [rows] = await pool.query(text, params);
      if (Array.isArray(rows)) return { rows };
      const header = rows as { affectedRows?: number };
      const result: QueryResult = { rows: [] };
      if (typeof header.affectedRows === "number") result.rowCount = header.affectedRows;
      return result;
    },
    end: () => pool.end(),
  };
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
  return {
    query(text, params = []): Promise<QueryResult> {
      const statement = db.prepare(text);
      if (statement.reader === false) {
        const info = statement.run(...params);
        return Promise.resolve({ rows: [], rowCount: info.changes });
      }
      return Promise.resolve({ rows: statement.all(...params) });
    },
    end(): Promise<void> {
      db.close();
      return Promise.resolve();
    },
  };
}
