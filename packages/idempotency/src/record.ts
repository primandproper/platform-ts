/**
 * The record shape this build writes and reads.
 *
 * Every record carries it, and a record stamped with anything else is **ignored rather than
 * misread** — see {@link IdempotencyRecord.version}. Bump it whenever the stored shape changes.
 */
export const RECORD_VERSION = 1;

/** The lifecycle stage of a record. */
export type RecordState =
  /** A claim: work has started and has not reported back. */
  | "in-flight"
  /** A finished result, safe to replay. */
  | "completed";

/**
 * What the store holds for a key. Written twice per execution: once to claim the key, once to
 * record the outcome.
 *
 * `T` must survive the store's round trip. The redis cache provider serialises with JSON, so
 * `Date`/`Map`/`Set` come back as their JSON shapes — keep `T` JSON-safe if the manager might
 * ever be pointed at a provider other than memory.
 */
export interface IdempotencyRecord<T> {
  /**
   * The record shape this was written with. A record written by a different version reads as a
   * miss rather than as an error: with a day-long TTL, treating an unreadable record as a
   * failure would turn one bad deploy into a day of failures.
   */
  version: number;
  /** The lifecycle stage. */
  state: RecordState;
  /** When this revision of the record was written, ISO-8601. */
  createdAt: string;
  /** Identifies the request this key was used for, so a *different* request can be detected. */
  fingerprint: string;
  /**
   * Identifies the execution that owns the claim. Only its owner may complete or release it,
   * which is what stops an execution that outlived its claim from overwriting whoever
   * re-claimed the key.
   */
  claimId: string;
  /** The recorded result. Present only once `state` is `completed`. */
  value?: T;
}

/**
 * The outcome of {@link IdempotencyManager.run}.
 *
 * All four are expected control flow, not failures, so none of them throw — the divergence from
 * the Go platform's error sentinels, and the same optional-over-sentinels stance the cache takes
 * for a miss. Thrown {@link PlatformError}s are reserved for genuine failures (an unreachable
 * record store, an unusable key).
 */
export type IdempotentResult<T> =
  /** The work ran here, now. */
  | { status: "executed"; value: T }
  /** A recorded result was replayed instead of re-running the work. */
  | { status: "replayed"; value: T }
  /**
   * The key names work that started elsewhere and has not reported back. Refused rather than
   * re-run, because "did it happen?" is unanswerable and running it again is the worse guess.
   */
  | { status: "in-flight" }
  /**
   * The key was already used for a *different* request. Reported rather than answered with the
   * earlier result, which would hide a client bug.
   */
  | { status: "fingerprint-mismatch" };

/** Narrows the two outcomes that carry a value, for callers that treat replay as success. */
export function hasValue<T>(
  result: IdempotentResult<T>,
): result is Extract<IdempotentResult<T>, { value: T }> {
  return result.status === "executed" || result.status === "replayed";
}
