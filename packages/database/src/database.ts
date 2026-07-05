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
 * The minimal pool surface this package instruments — the seam a query builder (Drizzle/Kysely) or
 * raw SQL sits on. Driver pools are adapted to it by the functions in `adapters.ts`.
 */
export interface QueryablePool {
  query(text: string, params?: readonly unknown[]): Promise<QueryResult>;
  /** Drains and closes the pool. */
  end(): Promise<void>;
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
  /** Runs a statement on `pool` inside an observability span. */
  query(
    pool: QueryablePool,
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult>;
}

/** Thrown when a client is used before its pools are reachable. */
export class DatabaseNotReadyError extends PlatformError {
  constructor() {
    super("database/not-ready", "database is not ready");
    this.name = "DatabaseNotReadyError";
  }
}

/** Observability plus the injectable runtime knobs the client uses. */
export interface DatabaseClientDeps extends ObservabilityDeps {
  /** Overrides `Date` for {@link DatabaseClient.currentTime}; injectable for tests. */
  now?: () => Date;
  /** Overrides the inter-ping delay; injectable so tests don't actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** The statement used to probe readiness. Defaults to `SELECT 1`. */
  pingQuery?: string;
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
    pool: QueryablePool,
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult> {
    const op = this.#observer.begin(`${o11yName}.query`);
    try {
      op.set("db.system", this.#config.provider).set("db.statement", text);
      const result = await pool.query(text, params);
      op.set("db.rows", result.rows.length);
      return result;
    } catch (error) {
      op.error(toError(error), "query failed");
      throw error;
    } finally {
      op.end();
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
