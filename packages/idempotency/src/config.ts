import { z } from "zod";

import { DEFAULT_MAX_KEY_LENGTH } from "./key.js";

/** One day, in milliseconds — how long a completed record stays replayable by default. */
const DEFAULT_TTL_MS = 86_400_000;

/** Two minutes, in milliseconds — the default deadline for the work a claim guards. */
const DEFAULT_IN_FLIGHT_TTL_MS = 120_000;

/**
 * Idempotency config. Replaces the Go platform's `env:`-tagged struct + ozzo validation.
 *
 * The record store and the locker are **not** configured here: both are runtime values built by
 * their own packages' factories and passed through deps, which is how the rest of this repo
 * composes (no DI container).
 */
export const IdempotencyConfigSchema = z.object({
  /**
   * Namespaces store and lock keys, so a client's key cannot collide with an unrelated entry in
   * a cache or locker shared with something else. An empty prefix is honoured — opting out is a
   * legitimate choice.
   */
  keyPrefix: z.string().default("idempotency:"),
  /**
   * How long a completed record stays replayable, in milliseconds. This is how long a client may
   * usefully retry; a day is the common answer and matches what payment providers publish.
   * Longer costs storage, shorter means a late retry re-executes.
   */
  ttlMs: z.number().int().positive().default(DEFAULT_TTL_MS),
  /**
   * How long a claim survives without being completed, in milliseconds.
   *
   * A deadline for the guarded work, not a tuning knob: set it above the worst case, not the
   * average. Every execution slower than this loses its claim *while still running*, which is
   * the one remaining path to a duplicate effect — watch `idempotency.claims.lost`. It is also
   * how long a client is refused after a process dies mid-execution, which is the best available
   * answer when the outcome is unknown.
   */
  inFlightTtlMs: z.number().int().positive().default(DEFAULT_IN_FLIGHT_TTL_MS),
  /** The longest client key accepted. `0` disables the length check. */
  maxKeyLength: z.number().int().nonnegative().default(DEFAULT_MAX_KEY_LENGTH),
  /**
   * What happens when the record store cannot be reached. The most consequential setting here,
   * because the two answers fail in opposite directions.
   *
   * `fail-closed` (the default) refuses the request: a brief outage becomes downtime rather than
   * duplicate charges, and it is the right answer wherever the guarded work costs money.
   * `fail-open` runs the work anyway, trading the guarantee for availability — appropriate only
   * where a duplicate effect is cheaper than a rejection.
   */
  storeFailurePolicy: z.enum(["fail-closed", "fail-open"]).default("fail-closed"),
  /**
   * Lease held while claiming, in milliseconds. Short by design: the lock covers a re-read and a
   * write, never the work itself.
   */
  lockTtlMs: z.number().int().positive().default(5_000),
  /**
   * How long to keep retrying a contended claim lock before giving up and answering `in-flight`,
   * in milliseconds. `0` means a single attempt.
   *
   * A wait exists because `DistributedLock.acquire` reports contention immediately rather than
   * blocking, and because lock keys can collide: the postgres provider folds a key into an
   * int64, so an unrelated key can contend. Under a short wait that collision costs a
   * sub-millisecond pause; without one it would answer a legitimate request with a refusal.
   */
  lockWaitMs: z.number().int().nonnegative().default(2_000),
  /** How long to wait between attempts on a contended claim lock, in milliseconds. */
  lockPollMs: z.number().int().positive().default(25),
});

export type IdempotencyConfig = z.infer<typeof IdempotencyConfigSchema>;
export type IdempotencyConfigInput = z.input<typeof IdempotencyConfigSchema>;

/** The store-failure policies, spelled out for callers switching on them. */
export type StoreFailurePolicy = IdempotencyConfig["storeFailurePolicy"];
