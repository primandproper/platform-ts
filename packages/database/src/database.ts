import { AsyncLocalStorage } from "node:async_hooks";

import { PlatformError } from "@primandproper/errors";
import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import {
  DatabaseConfigSchema,
  type DatabaseConfig,
  type DatabaseConfigInput,
} from "./config.js";

const o11yName = "database";

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The normalized shape of a query result, regardless of driver. */
export interface QueryResult {
  /** The returned rows; empty for non-`SELECT` statements. */
  rows: unknown[];
  /** Rows affected, when the driver reports it. */
  rowCount?: number;
}

/**
 * Anything statements can be issued through: a pool, or the pinned connection a transaction runs
 * on. It is deliberately the *whole* surface — no `end()`, no commit, no rollback — so a function
 * written against `Queryable` composes with either, and holding one inside
 * {@link DatabaseClient.withTransaction} grants no way to end the transaction or the pool.
 */
export interface Queryable {
  query(text: string, params?: readonly unknown[]): Promise<QueryResult>;
}

/**
 * A connection checked out of a pool and pinned for the life of a transaction. Returned by
 * {@link QueryablePool.connect} and released by {@link DatabaseClient.withTransaction}, never by
 * the caller — which is why it never reaches the transaction callback.
 */
export interface PooledConnection extends Queryable {
  /** Returns the connection to its pool. Idempotent in every adapter here. */
  release(): void | Promise<void>;
}

/**
 * The minimal pool surface this package instruments — the seam a query builder (Drizzle/Kysely) or
 * raw SQL sits on. Driver pools are adapted to it by the functions in `adapters.ts`.
 */
export interface QueryablePool extends Queryable {
  /** Drains and closes the pool. */
  end(): Promise<void>;
  /**
   * Checks out a connection pinned to the caller. Optional because the seam is structural: a pool
   * that cannot pin a connection cannot run a transaction, and {@link DatabaseClient.withTransaction}
   * rejects with {@link TransactionsUnsupportedError} rather than silently spreading the statements
   * across arbitrary pooled connections — which is the failure that looks like it worked.
   */
  connect?(): Promise<PooledConnection>;
}

/**
 * An instrumented database client: a read pool, a write pool (the same instance when only one
 * endpoint is configured), readiness probing, and lifecycle. The narrow analogue of platform-go's
 * dialect `database.Client` — no query-executor inheritance, no migrations.
 */
export interface DatabaseClient {
  readonly readPool: QueryablePool;
  readonly writePool: QueryablePool;
  /** Pings each distinct pool, retrying per the configured ping settings; `false` if any stays down. */
  isReady(): Promise<boolean>;
  /**
   * Fail-fast variant of {@link isReady}: resolves when ready, otherwise rejects with a
   * {@link DatabaseNotReadyError}. The underlying driver error (auth/host/TLS) is already logged at
   * error level by the readiness probe. Use this at startup to abort instead of limping on.
   */
  ensureReady(): Promise<void>;
  /** Closes each distinct pool. */
  close(): Promise<void>;
  /** The client's notion of "now", injectable for tests. */
  currentTime(): Date;
  /**
   * Runs a statement on `target` inside an observability span. Accepts the narrow {@link Queryable},
   * so statements issued inside {@link withTransaction} are instrumented the same way pool queries are.
   */
  query(
    target: Queryable,
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult>;
  /**
   * Runs `fn` inside a single transaction on the **write** pool, on one pinned connection.
   * Resolving commits; rejecting rolls back and re-throws the original error unchanged.
   *
   * `fn` receives a bare {@link Queryable} and nothing else: it cannot commit, roll back, close
   * the pool, or outlive the closure. Lifecycle belongs to this method, which acquires the
   * connection and releases it in a `finally` — including when the rollback itself fails.
   *
   * Nesting is **not** supported and throws {@link NestedTransactionError} rather than silently
   * flattening two scopes into one (there are no savepoints). Detection is per async context, so
   * genuinely concurrent transactions on the same client are unaffected, and nesting a *different*
   * client's transaction inside this one is allowed — two databases have no shared commit and this
   * package does not pretend otherwise.
   *
   * A failed commit throws {@link TransactionCommitError} and does not attempt a rollback: the
   * driver has already ended the transaction and returned the connection, so a second attempt would
   * only surface a spurious "no transaction in progress".
   */
  withTransaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
}

/** Thrown when a client is used before its pools are reachable. */
export class DatabaseNotReadyError extends PlatformError {
  constructor() {
    super("database/not-ready", "database is not ready");
    this.name = "DatabaseNotReadyError";
  }
}

/** Thrown by {@link DatabaseClient.withTransaction} when the write pool cannot pin a connection. */
export class TransactionsUnsupportedError extends PlatformError {
  constructor(provider: string) {
    super(
      "database/transactions-unsupported",
      `the ${provider} write pool does not expose connect(), so it cannot run a transaction`,
    );
    this.name = "TransactionsUnsupportedError";
  }
}

/** Thrown when {@link DatabaseClient.withTransaction} is called inside its own transaction. */
export class NestedTransactionError extends PlatformError {
  constructor() {
    super(
      "database/nested-transaction",
      "withTransaction cannot be nested on the same client; savepoints are not supported",
    );
    this.name = "NestedTransactionError";
  }
}

/**
 * Thrown when `COMMIT` fails. Distinct from an error thrown by the callback because the outcome is
 * different in kind: the callback's work provably did not land, whereas a failed commit leaves the
 * transaction's fate unknown to this process. The driver error is the `cause`.
 */
export class TransactionCommitError extends PlatformError {
  constructor(cause: Error) {
    super("database/commit-failed", "committing transaction", { cause });
    this.name = "TransactionCommitError";
  }
}

/**
 * The clients whose transactions are open in the current async context. Async-context-scoped rather
 * than a field on the client, because a per-instance flag would call two concurrent requests a
 * nesting violation — the common case — while still missing a genuine nest across an `await`.
 */
const openTransactions = new AsyncLocalStorage<ReadonlySet<DatabaseClient>>();

/** Observability plus the injectable runtime knobs the client uses. */
export interface DatabaseClientDeps extends ObservabilityDeps {
  /** Overrides `Date` for {@link DatabaseClient.currentTime}; injectable for tests. */
  now?: () => Date;
  /** Overrides the inter-ping delay; injectable so tests don't actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** The statement used to probe readiness. Defaults to `SELECT 1`. */
  pingQuery?: string;
  /**
   * The statement that opens a transaction. Defaults to `BEGIN`, which postgres, mysql, and sqlite
   * all accept. Override it where the dialect's default locking mode is wrong for the workload —
   * sqlite's `BEGIN IMMEDIATE` takes the write lock up front instead of failing with `SQLITE_BUSY`
   * when a deferred transaction tries to upgrade mid-flight.
   */
  beginStatement?: string;
}

class InstrumentedClient implements DatabaseClient {
  readonly readPool: QueryablePool;
  readonly writePool: QueryablePool;
  readonly #config: DatabaseConfig;
  readonly #observer: Observer;
  readonly #logger: Logger;
  readonly #now: () => Date;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #pingQuery: string;
  readonly #beginStatement: string;

  constructor(
    readPool: QueryablePool,
    writePool: QueryablePool,
    config: DatabaseConfig,
    deps: DatabaseClientDeps = {},
  ) {
    this.readPool = readPool;
    this.writePool = writePool;
    this.#config = config;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
    this.#now = deps.now ?? ((): Date => new Date());
    this.#sleep = deps.sleep ?? defaultSleep;
    this.#pingQuery = deps.pingQuery ?? "SELECT 1";
    this.#beginStatement = deps.beginStatement ?? "BEGIN";
  }

  async isReady(): Promise<boolean> {
    const op = this.#observer.begin(`${o11yName}.isReady`);
    try {
      op.set("db.system", this.#config.provider)
        .set("db.ping.max_attempts", this.#config.maxPingAttempts)
        .set("db.ping.wait_period_ms", this.#config.pingWaitPeriodMs);
      if (!(await this.#waitForPing(this.readPool, "read"))) return false;
      if (this.writePool !== this.readPool) {
        return await this.#waitForPing(this.writePool, "write");
      }
      return true;
    } finally {
      op.end();
    }
  }

  async ensureReady(): Promise<void> {
    if (!(await this.isReady())) {
      throw new DatabaseNotReadyError();
    }
  }

  async #waitForPing(pool: QueryablePool, name: string): Promise<boolean> {
    let attempt = 0;
    for (;;) {
      try {
        await pool.query(this.#pingQuery);
        return true;
      } catch (err) {
        if (attempt >= this.#config.maxPingAttempts) {
          // A database that never comes ready is an error, not a debug footnote — and the driver
          // error (auth failure, wrong host, TLS) is the diagnostic that matters, so surface it.
          this.#logger.error(`ping failed for ${name} connection`, toError(err), {
            connection: name,
            attempts: attempt + 1,
          });
          return false;
        }
        await this.#sleep(this.#config.pingWaitPeriodMs);
        attempt += 1;
      }
    }
  }

  async close(): Promise<void> {
    // Drain every distinct pool even if one rejects — a failed read-pool `end()` must not leak the
    // write pool. Settle all, log each failure with its cause, then surface the failure(s).
    const pools =
      this.writePool === this.readPool
        ? [this.readPool]
        : [this.readPool, this.writePool];
    const results = await Promise.allSettled(pools.map((pool) => pool.end()));
    const failures = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => toError(r.reason));
    for (const err of failures) {
      this.#logger.error("closing database pool", err);
    }
    const [first, ...rest] = failures;
    if (first !== undefined) {
      throw rest.length === 0
        ? first
        : new AggregateError(failures, "closing database pools failed");
    }
  }

  currentTime(): Date {
    return this.#now();
  }

  async query(
    target: Queryable,
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult> {
    const op = this.#observer.begin(`${o11yName}.query`);
    try {
      op.set("db.system", this.#config.provider).set("db.statement", text);
      const result = await target.query(text, params);
      op.set("db.rows", result.rows.length);
      return result;
    } catch (error) {
      op.error(toError(error), "query failed");
      throw error;
    } finally {
      op.end();
    }
  }

  async withTransaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const enclosing = openTransactions.getStore();
    if (enclosing?.has(this)) throw new NestedTransactionError();

    // The write pool only. A transaction on the read pool targets a replica, where it either fails
    // outright or reads a stale snapshot and discards every write in it.
    const pool = this.writePool;
    if (typeof pool.connect !== "function") {
      throw new TransactionsUnsupportedError(this.#config.provider);
    }

    const op = this.#observer.begin(`${o11yName}.withTransaction`);
    op.set("db.system", this.#config.provider);
    let connection: PooledConnection | undefined;
    try {
      connection = await pool.connect();
      await connection.query(this.#beginStatement);
      const pinned = connection;

      let value: T;
      try {
        // Re-wrap rather than passing `pinned` straight through: the connection carries `release()`,
        // and the callback holding an object it must not call is a weaker guarantee than it not
        // holding one at all.
        const scope = new Set(enclosing ?? []).add(this);
        value = await openTransactions.run(scope, () =>
          fn({ query: (text, params) => pinned.query(text, params) }),
        );
      } catch (error) {
        await this.#rollback(pinned, toError(error));
        throw error;
      }

      try {
        await pinned.query("COMMIT");
      } catch (error) {
        throw new TransactionCommitError(toError(error));
      }
      return value;
    } catch (error) {
      op.error(toError(error), "transaction failed");
      throw error;
    } finally {
      // Release even when BEGIN, the callback, the rollback, or the commit failed — one connection
      // leaked per transaction exhausts the pool, and presents as unrelated latency far from here.
      if (connection !== undefined) await this.#release(connection);
      op.end();
    }
  }

  /**
   * Rolls back, swallowing any failure. The error that caused the rollback is what the caller needs;
   * replacing it with the cleanup failure would discard the diagnosis, so the cleanup failure is
   * logged with its cause attached instead.
   */
  async #rollback(connection: PooledConnection, cause: Error): Promise<void> {
    try {
      await connection.query("ROLLBACK");
    } catch (err) {
      this.#logger.error("rolling back transaction", toError(err), {
        rollbackCause: cause.message,
      });
    }
  }

  /** Releases the connection, logging rather than throwing so it cannot mask the caller's error. */
  async #release(connection: PooledConnection): Promise<void> {
    try {
      await connection.release();
    } catch (err) {
      this.#logger.error("releasing transaction connection", toError(err));
    }
  }
}

/** The driver pools to instrument. `write` defaults to `read` for a single-endpoint setup. */
export interface DatabasePools {
  read: QueryablePool;
  write?: QueryablePool;
}

/**
 * Wraps caller-provided driver pools in an instrumented {@link DatabaseClient}. The caller builds
 * the pools from their driver of choice (see `adapters.ts`) using the connection strings derived
 * from config — keeping ownership of the connection with the query layer, per the TS port's scope.
 */
export function provideDatabase(
  config: DatabaseConfigInput,
  pools: DatabasePools,
  deps?: DatabaseClientDeps,
): DatabaseClient {
  const cfg = DatabaseConfigSchema.parse(config);
  return new InstrumentedClient(pools.read, pools.write ?? pools.read, cfg, deps);
}
