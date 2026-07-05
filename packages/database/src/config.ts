import { z } from "zod";

/** The supported SQL dialects. */
export const DatabaseProviders = ["postgres", "mysql", "sqlite"] as const;
export type DatabaseProvider = (typeof DatabaseProviders)[number];

/**
 * Connection coordinates for one endpoint. For `sqlite`, only `database` (the file path, or
 * `:memory:`) is meaningful; the network fields are ignored.
 */
export const ConnectionDetailsSchema = z.object({
  username: z.string().default(""),
  password: z.string().default(""),
  database: z.string().default(""),
  host: z.string().default("localhost"),
  port: z.number().int().nonnegative().default(5432),
  disableSSL: z.boolean().default(false),
});

export type ConnectionDetails = z.infer<typeof ConnectionDetailsSchema>;
export type ConnectionDetailsInput = z.input<typeof ConnectionDetailsSchema>;

/** Default pool and ping settings, mirroring platform-go's `databasecfg` defaults. */
export const DEFAULT_MAX_IDLE_CONNS = 5;
export const DEFAULT_MAX_OPEN_CONNS = 7;
export const DEFAULT_CONN_MAX_LIFETIME_MS = 30 * 60 * 1000;
export const DEFAULT_PING_WAIT_PERIOD_MS = 1000;

/**
 * Database config. The `read` endpoint is required; `write` defaults to `read` (single endpoint).
 * Pool/ping settings carry the same defaults as platform-go.
 */
export const DatabaseConfigSchema = z.object({
  provider: z.enum(DatabaseProviders).default("postgres"),
  read: ConnectionDetailsSchema,
  write: ConnectionDetailsSchema.optional(),
  maxIdleConns: z.number().int().positive().default(DEFAULT_MAX_IDLE_CONNS),
  maxOpenConns: z.number().int().positive().default(DEFAULT_MAX_OPEN_CONNS),
  connMaxLifetimeMs: z.number().int().nonnegative().default(DEFAULT_CONN_MAX_LIFETIME_MS),
  /** Retries after the first failed ping before {@link DatabaseClient.isReady} gives up. */
  maxPingAttempts: z.number().int().nonnegative().default(0),
  pingWaitPeriodMs: z.number().int().nonnegative().default(DEFAULT_PING_WAIT_PERIOD_MS),
});

export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;
export type DatabaseConfigInput = z.input<typeof DatabaseConfigSchema>;

/**
 * Quotes a libpq key=value component. An empty value, or one containing whitespace, a single
 * quote, or a backslash, is single-quoted with `'` and `\` backslash-escaped — otherwise a
 * password like `p@ss word` would silently truncate the DSN at the space.
 */
function pgKeyValueQuote(value: string): string {
  if (value === "" || /[\s'\\]/u.test(value)) {
    return `'${value.replace(/(['\\])/gu, "\\$1")}'`;
  }
  return value;
}

/** Postgres key=value DSN (`pgx`/libpq style). Components are quoted so special chars survive. */
export function postgresKeyValue(cd: ConnectionDetails): string {
  return `user=${pgKeyValueQuote(cd.username)} password=${pgKeyValueQuote(cd.password)} database=${pgKeyValueQuote(cd.database)} host=${pgKeyValueQuote(cd.host)} port=${String(cd.port)}`;
}

/**
 * Postgres connection URI, the idiomatic form for `node-postgres`. (platform-go hands `pgx` a
 * key=value DSN; the URI is equivalent and what JS drivers expect.)
 */
export function postgresUri(cd: ConnectionDetails): string {
  const auth = `${encodeURIComponent(cd.username)}:${encodeURIComponent(cd.password)}`;
  const base = `postgres://${auth}@${cd.host}:${String(cd.port)}/${encodeURIComponent(cd.database)}`;
  return cd.disableSSL ? `${base}?sslmode=disable` : base;
}

/**
 * MySQL connection URI (`mysql://user:pass@host:port/db`) — the form `mysql2` parses. platform-go
 * hands `go-sql-driver` its `user:pass@tcp(host:port)/db` DSN, which no JS driver understands; the
 * URI is the equivalent JS drivers expect. Credentials are percent-encoded so `@`/`:`/`/` survive.
 */
export function mysqlDsn(cd: ConnectionDetails): string {
  const auth = `${encodeURIComponent(cd.username)}:${encodeURIComponent(cd.password)}`;
  return `mysql://${auth}@${cd.host}:${String(cd.port)}/${encodeURIComponent(cd.database)}`;
}

/** SQLite "DSN" — just the database file path. */
export function sqlitePath(cd: ConnectionDetails): string {
  return cd.database;
}

/**
 * `node-postgres` `Pool` options derived from the driver-agnostic pool config, so these settings
 * actually reach a pool rather than being parsed and discarded. `maxOpenConns` → `max`;
 * `connMaxLifetimeMs` → `maxLifetimeSeconds`. pg bounds only the total client count (`max`) and has
 * no separate idle cap, so `maxIdleConns` has no pg equivalent and is intentionally not mapped.
 * Spread into pool construction: `new Pool({ connectionString, ...pgPoolSettings(cfg) })`.
 */
export function pgPoolSettings(config: DatabaseConfig): {
  max: number;
  maxLifetimeSeconds: number;
} {
  return {
    max: config.maxOpenConns,
    maxLifetimeSeconds: Math.ceil(config.connMaxLifetimeMs / 1000),
  };
}

/**
 * `mysql2` `Pool` options derived from the pool config. `maxOpenConns` → `connectionLimit`;
 * `maxIdleConns` → `maxIdle`. mysql2 has no per-connection max-lifetime, so `connMaxLifetimeMs` is
 * intentionally not mapped. Spread into pool construction:
 * `mysql.createPool({ uri, ...mysqlPoolSettings(cfg) })`.
 */
export function mysqlPoolSettings(config: DatabaseConfig): {
  connectionLimit: number;
  maxIdle: number;
} {
  return {
    connectionLimit: config.maxOpenConns,
    maxIdle: config.maxIdleConns,
  };
}

function connectionStringFor(provider: DatabaseProvider, cd: ConnectionDetails): string {
  switch (provider) {
    case "postgres":
      return postgresUri(cd);
    case "mysql":
      return mysqlDsn(cd);
    case "sqlite":
      return sqlitePath(cd);
  }
}

/** The read endpoint's connection string for the configured provider. */
export function readConnectionString(config: DatabaseConfig): string {
  return connectionStringFor(config.provider, config.read);
}

/** The write endpoint's connection string, falling back to the read endpoint. */
export function writeConnectionString(config: DatabaseConfig): string {
  return connectionStringFor(config.provider, config.write ?? config.read);
}
