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

/** Postgres key=value DSN (`pgx`/libpq style). */
export function postgresKeyValue(cd: ConnectionDetails): string {
  return `user=${cd.username} password=${cd.password} database=${cd.database} host=${cd.host} port=${String(cd.port)}`;
}

/**
 * Postgres connection URI, the idiomatic form for `node-postgres`. (platform-go hands `pgx` a
 * key=value DSN; the URI is equivalent and what JS drivers expect.)
 */
export function postgresUri(cd: ConnectionDetails): string {
  const auth = `${encodeURIComponent(cd.username)}:${encodeURIComponent(cd.password)}`;
  const base = `postgres://${auth}@${cd.host}:${String(cd.port)}/${cd.database}`;
  return cd.disableSSL ? `${base}?sslmode=disable` : base;
}

/** MySQL DSN in `go-sql-driver`/`mysql2` form. */
export function mysqlDsn(cd: ConnectionDetails): string {
  return `${cd.username}:${cd.password}@tcp(${cd.host}:${String(cd.port)})/${cd.database}`;
}

/** SQLite "DSN" — just the database file path. */
export function sqlitePath(cd: ConnectionDetails): string {
  return cd.database;
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
