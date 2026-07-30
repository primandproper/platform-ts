import type { Cache } from "@primandproper/cache";
import type { DistributedLock } from "@primandproper/distributedlock";
import { isPlatformError, messageOf, PlatformError } from "@primandproper/errors";
import { provideIdentifierGenerator } from "@primandproper/identifiers";
import {
  makeObserver,
  type ObservabilityDeps,
  type Observer,
  type Operation,
} from "@primandproper/observability";

import { IdempotencyConfigSchema, type IdempotencyConfigInput } from "./config.js";
import { idempotencyInstruments, type IdempotencyInstruments } from "./instruments.js";
import {
  IdempotencyErrorCode,
  validateIdempotencyKey,
  type Fingerprint,
  type IdempotencyKey,
} from "./key.js";
import {
  RECORD_VERSION,
  type IdempotencyRecord,
  type IdempotentResult,
} from "./record.js";
import { withLock, type LockAttempt } from "./with-lock.node.js";

const o11yName = "idempotency";

/**
 * What a manager needs at runtime. The store and the locker are required and have no defaults:
 * an implicit noop locker would leave replay working while quietly removing mutual exclusion,
 * which is the failure mode hardest to notice and most expensive to meet.
 */
export interface IdempotencyDeps<T> extends ObservabilityDeps {
  /**
   * Where records live. Use a cross-process provider (redis) in production: the memory provider
   * is per-process, so replicas would not see each other's records.
   */
  store: Cache<IdempotencyRecord<T>>;
  /**
   * The lock guarding the claim. Note that `noop` acquires unconditionally — with it, replay
   * still works (which covers the ordinary timeout-then-retry case) but two genuinely concurrent
   * requests can both claim and both execute.
   */
  lock: DistributedLock;
  /**
   * Decides whether a result is worth recording. A result it rejects releases the claim instead,
   * so the next attempt runs the work again.
   *
   * This is how a caller says "that failure was ours, not theirs": a server-side error usually
   * means the effect did not land, and pinning it for the whole TTL would strand a client that
   * could have succeeded on retry. Defaults to recording everything the work returns.
   */
  recordable?: (value: T) => boolean;
  /** Injectable clock for record timestamps and the claim-lock wait, for deterministic tests. */
  now?: () => number;
  /** Injectable delay for the claim-lock wait, for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable claim-id generation, for deterministic tests. */
  generateClaimId?: () => string;
}

/** Per-call overrides. */
export interface RunOptions {
  /**
   * Overrides how long *this* call's completed record is retained, in milliseconds.
   *
   * Retention is the window in which a retry replays instead of re-running, so it belongs to the
   * operation rather than to the manager: a payment worth protecting for a day and a profile
   * update worth protecting for a minute can then share one manager. There is deliberately no
   * per-call `inFlightTtlMs` — that bounds how long a dead process blocks a retry, which is a
   * property of the deployment rather than of the call.
   */
  ttlMs?: number;
}

/** Outcomes reported on `idempotency.requests`; the four together are the request total. */
type Outcome = "executed" | "replayed" | "in_flight" | "mismatch";

/** What claiming a key produced. */
type Claim<T> =
  /** The claim is ours, and `claimId` is what proves it at completion time. */
  | { kind: "claimed"; claimId: string }
  /** Someone landed a record between the pre-lock read and the lock. */
  | { kind: "existing"; record: IdempotencyRecord<T> }
  /** The claim lock stayed held for the whole wait — someone else is claiming this key now. */
  | { kind: "contended" };

const defaultIdentifiers = provideIdentifierGenerator();

/**
 * Runs work at most once per client-supplied key.
 *
 * A concrete class rather than an interface: there is one implementation, and the seams worth
 * swapping — the store and the locker — are already interfaces of their own.
 *
 * What it guarantees is at-most-once **effect**, not exactly-once. The gap is worth naming: work
 * that has its effect and *then* fails is not covered. The charge landed, the error came back,
 * nothing was recorded, and the retry charges again. Recording failures instead would be worse —
 * a transient error would be pinned for the whole TTL and the client could never succeed — which
 * is what {@link IdempotencyDeps.recordable} exists to let a caller tune.
 */
export class IdempotencyManager<T> {
  readonly #store: Cache<IdempotencyRecord<T>>;
  readonly #lock: DistributedLock;
  readonly #observer: Observer;
  readonly #instruments: IdempotencyInstruments;
  readonly #recordable: (value: T) => boolean;
  readonly #now: () => number;
  readonly #newClaimId: () => string;
  readonly #keyPrefix: string;
  readonly #ttlMs: number;
  readonly #inFlightTtlMs: number;
  readonly #maxKeyLength: number;
  readonly #failOpen: boolean;
  readonly #lockTtlMs: number;
  readonly #lockWaitMs: number;
  readonly #lockPollMs: number;
  readonly #sleep: ((ms: number) => Promise<void>) | undefined;

  constructor(config: IdempotencyConfigInput | undefined, deps: IdempotencyDeps<T>) {
    const cfg = IdempotencyConfigSchema.parse(config ?? {});
    this.#store = deps.store;
    this.#lock = deps.lock;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#instruments = idempotencyInstruments(o11yName, deps);
    this.#recordable = deps.recordable ?? ((): boolean => true);
    this.#now = deps.now ?? ((): number => Date.now());
    this.#newClaimId =
      deps.generateClaimId ?? ((): string => defaultIdentifiers.generate());
    this.#sleep = deps.sleep;
    this.#keyPrefix = cfg.keyPrefix;
    this.#ttlMs = cfg.ttlMs;
    this.#inFlightTtlMs = cfg.inFlightTtlMs;
    this.#maxKeyLength = cfg.maxKeyLength;
    this.#failOpen = cfg.storeFailurePolicy === "fail-open";
    this.#lockTtlMs = cfg.lockTtlMs;
    this.#lockWaitMs = cfg.lockWaitMs;
    this.#lockPollMs = cfg.lockPollMs;
  }

  /**
   * Runs `fn` at most once for `key`.
   *
   * The protocol is four steps, and the order is the correctness argument:
   *
   * 1. read the record — replay, refuse, or continue;
   * 2. lock → **re-read** → write an in-flight claim → unlock;
   * 3. run the work *outside* the lock;
   * 4. record the result, or release the claim.
   *
   * The re-read inside the lock is what makes it correct: two callers that both missed the
   * pre-lock read would otherwise both claim, and the second would overwrite the first.
   *
   * The work runs outside the lock because a held lock is a held resource (the postgres lock
   * provider runs inside a transaction — an open transaction per in-flight request means pool
   * exhaustion and blocked vacuums), because lock leases are shorter than real work (anything
   * slower loses mutual exclusion *while still running*), and because a lock leaves no evidence:
   * kill a process mid-execution and the lock evaporates, while a *record* with its own TTL
   * survives and correctly refuses the retry until it expires.
   *
   * An error thrown by `fn` propagates unchanged and the claim is released, so the next attempt
   * runs the work again. An unusable key, an empty fingerprint, or an unreachable store throw a
   * {@link PlatformError}; the four ordinary outcomes are returned, not thrown.
   */
  run(
    key: IdempotencyKey,
    fingerprint: Fingerprint,
    fn: () => Promise<T> | T,
    options: RunOptions = {},
  ): Promise<IdempotentResult<T>> {
    return this.#observer.run("run", async (op) => {
      validateIdempotencyKey(key, this.#maxKeyLength);
      if (fingerprint === "") {
        // Defaulting it would make every request for a key look identical and disable mismatch
        // detection entirely, so it is rejected rather than filled in.
        throw new PlatformError(
          IdempotencyErrorCode.fingerprintRequired,
          "empty idempotency fingerprint",
        );
      }

      op.set("idempotency.key", key).set("idempotency.fingerprint", fingerprint);

      const ttlMs =
        options.ttlMs !== undefined && options.ttlMs > 0 ? options.ttlMs : this.#ttlMs;
      const storeKey = this.#storeKey(key);

      // Read before locking. The overwhelmingly common case is a replay of a completed record,
      // and it costs one round trip with no coordination at all.
      const existing = await this.#load(op, storeKey);
      if (existing !== undefined) {
        return this.#resolve(op, existing, fingerprint);
      }

      const claim = await this.#claim(op, key, storeKey, fingerprint);
      switch (claim.kind) {
        case "existing":
          return this.#resolve(op, claim.record, fingerprint);
        case "contended":
          // Someone else holds the claim lock for this key right now, so they are about to write
          // (or have just written) an in-flight record. Refusing is the same answer that record
          // would produce, one round trip earlier.
          op.logger().debug("claim lock contended; reporting in flight");
          this.#count("in_flight");
          return { status: "in-flight" };
        case "claimed":
          break;
      }

      const { claimId } = claim;

      let value: T;
      try {
        value = await fn();
      } catch (err) {
        await this.#release(op, storeKey, claimId);
        throw err;
      }

      if (!this.#recordable(value)) {
        op.set("idempotency.recorded", false);
        await this.#release(op, storeKey, claimId);
        this.#count("executed");
        return { status: "executed", value };
      }

      await this.#commit(op, storeKey, claimId, fingerprint, value, ttlMs);
      this.#count("executed");
      return { status: "executed", value };
    });
  }

  /**
   * Turns a stored record into an answer.
   *
   * The fingerprint is checked before the state, deliberately: a client reusing one key for two
   * different requests has a bug worth surfacing immediately, and answering `in-flight` instead
   * would tell it to retry — the one thing that cannot help.
   */
  #resolve(
    op: Operation,
    record: IdempotencyRecord<T>,
    fingerprint: Fingerprint,
  ): IdempotentResult<T> {
    if (record.fingerprint !== fingerprint) {
      op.logger().warn("idempotency key reused with a different request");
      this.#count("mismatch");
      return { status: "fingerprint-mismatch" };
    }

    switch (record.state) {
      case "completed":
        op.set("idempotency.replayed", true);
        this.#count("replayed");
        // A completed record without a value is one whose work returned `undefined`; the state
        // is what says it finished, so the value is replayed as it was stored.
        return { status: "replayed", value: record.value as T };
      case "in-flight":
        this.#count("in_flight");
        return { status: "in-flight" };
      default:
        // A state this build does not know is treated like a shape it cannot read: refuse rather
        // than guess, since the alternative is running work that may already have run.
        this.#instruments.staleRecords.add(1);
        op.logger().warn("ignoring idempotency record in an unknown state");
        this.#count("in_flight");
        return { status: "in-flight" };
    }
  }

  /**
   * Writes the in-flight record under the lock, returning either the claim id it took or the
   * record that made claiming unnecessary. The lock covers a re-read and a write and nothing
   * else.
   */
  async #claim(
    op: Operation,
    key: IdempotencyKey,
    storeKey: string,
    fingerprint: Fingerprint,
  ): Promise<Claim<T>> {
    let attempt: LockAttempt<Claim<T>>;
    try {
      attempt = await withLock<Claim<T>>(
        this.#lock,
        this.#lockKey(key),
        async () => {
          const existing = await this.#load(op, storeKey);
          if (existing !== undefined) {
            return { kind: "existing", record: existing };
          }

          const claimId = this.#newClaimId();
          await this.#store.set(
            storeKey,
            {
              version: RECORD_VERSION,
              state: "in-flight",
              createdAt: new Date(this.#now()).toISOString(),
              fingerprint,
              claimId,
            },
            { ttlMs: this.#inFlightTtlMs },
          );
          return { kind: "claimed", claimId };
        },
        {
          ttlMs: this.#lockTtlMs,
          waitMs: this.#lockWaitMs,
          pollMs: this.#lockPollMs,
          now: this.#now,
          onReleaseError: (err) => {
            op.acknowledge(err, "releasing idempotency claim lock");
          },
          ...(this.#sleep !== undefined ? { sleep: this.#sleep } : {}),
        },
      );
    } catch (err) {
      // A read inside the lock that already went through the policy is re-thrown untouched;
      // wrapping it again would double-count the store error and bury the original message.
      if (isPlatformError(err, IdempotencyErrorCode.storeUnavailable)) {
        throw err;
      }
      // Either the locker failed or the claim write did, and neither consults the store-failure
      // policy: it governs *reads* only. A read can fail open because "no record" is a coherent
      // (if unprotected) answer to carry on from; a claim that could not be written leaves
      // nothing for the completion to prove ownership against, so there is no state in which
      // running the work is a defensible guess. platform-go draws the line in the same place.
      this.#instruments.storeErrors.add(1);
      throw new PlatformError(
        IdempotencyErrorCode.storeUnavailable,
        `claiming idempotency key: ${messageOf(err)}`,
        { cause: err },
      );
    }

    return attempt.acquired ? attempt.value : { kind: "contended" };
  }

  /**
   * Records a finished result, but only if the claim is still ours.
   *
   * A failure here is counted and logged, never thrown: the work already happened and the caller
   * is entitled to its result. What the caller loses is the replay, so the next attempt runs the
   * work again — which is exactly what `idempotency.record.failures` is for.
   */
  async #commit(
    op: Operation,
    storeKey: string,
    claimId: string,
    fingerprint: Fingerprint,
    value: T,
    ttlMs: number,
  ): Promise<void> {
    if (!(await this.#stillOurs(op, storeKey, claimId, "completing"))) {
      return;
    }

    try {
      await this.#store.set(
        storeKey,
        {
          version: RECORD_VERSION,
          state: "completed",
          createdAt: new Date(this.#now()).toISOString(),
          fingerprint,
          claimId,
          value,
        },
        { ttlMs },
      );
      op.set("idempotency.recorded", true);
    } catch (err) {
      this.#instruments.recordFailures.add(1);
      op.acknowledge(err, "recording idempotency result");
    }
  }

  /**
   * Drops our claim so the next attempt can run the work again.
   *
   * Best-effort by design: if it fails, the claim expires on its own `inFlightTtlMs` and callers
   * are refused until then. Surfacing the failure would replace a delay with an error for work
   * that already completed.
   */
  async #release(op: Operation, storeKey: string, claimId: string): Promise<void> {
    if (!(await this.#stillOurs(op, storeKey, claimId, "releasing"))) {
      return;
    }

    try {
      await this.#store.delete(storeKey);
    } catch (err) {
      op.acknowledge(err, "releasing idempotency claim");
    }
  }

  /**
   * Reports whether the stored record is still the claim this execution took.
   *
   * It is false when the work outran `inFlightTtlMs`, the claim expired, and someone else
   * re-claimed the key — the one remaining path to a duplicate effect, and the reason
   * `idempotency.claims.lost` is the counter to alert on. Writing through it would compound the
   * problem by handing the new owner a result from a different execution.
   */
  async #stillOurs(
    op: Operation,
    storeKey: string,
    claimId: string,
    action: string,
  ): Promise<boolean> {
    let record: IdempotencyRecord<T> | undefined;
    try {
      record = await this.#load(op, storeKey);
    } catch (err) {
      this.#instruments.recordFailures.add(1);
      op.acknowledge(err, `reading idempotency claim before ${action}`);
      return false;
    }

    // A read that failed open arrives here as `undefined` and is therefore counted as a lost
    // claim. That is the honest reading: we could not confirm the claim is ours, and the write
    // is skipped for the same reason it would be if someone else had taken it.
    if (record?.claimId !== claimId) {
      this.#instruments.claimsLost.add(1);
      op.logger().warn(
        "idempotency claim lost before it could be completed; the work may run again",
        { "idempotency.claim_id": claimId, "idempotency.action": action },
      );
      return false;
    }

    return true;
  }

  /**
   * Reads a record, reporting `undefined` when there is nothing usable to this build.
   *
   * A record written by a different version reads as absent rather than as an error: with a
   * day-long TTL, failing on it would turn one bad deploy into a day of failures.
   *
   * **This is the only place the store-failure policy applies.** `fail-closed` throws;
   * `fail-open` reports the read as a miss and carries on, which is what trades the guarantee for
   * availability. The two are indistinguishable to the caller by design — "nothing recorded" is
   * exactly the answer fail-open elects to proceed from.
   */
  async #load(
    op: Operation,
    storeKey: string,
  ): Promise<IdempotencyRecord<T> | undefined> {
    let record: IdempotencyRecord<T> | undefined;
    try {
      record = await this.#store.get(storeKey);
    } catch (err) {
      this.#instruments.storeErrors.add(1);
      if (!this.#failOpen) {
        throw new PlatformError(
          IdempotencyErrorCode.storeUnavailable,
          `reading idempotency record: ${messageOf(err)}`,
          { cause: err },
        );
      }
      op.acknowledge(err, "reading idempotency record, failing open");
      return undefined;
    }

    if (record === undefined) {
      return undefined;
    }

    if (record.version !== RECORD_VERSION) {
      this.#instruments.staleRecords.add(1);
      op.logger().debug(
        "ignoring idempotency record written by a different record version",
        {
          "idempotency.record_version": record.version,
        },
      );
      return undefined;
    }

    return record;
  }

  /** Records one resolved request against its outcome. */
  #count(outcome: Outcome): void {
    this.#instruments.requests.add(1, { outcome });
  }

  /** Namespaces a caller's key for the record store. */
  #storeKey(key: IdempotencyKey): string {
    return `${this.#keyPrefix}${key}`;
  }

  /**
   * Namespaces a caller's key for the locker. Deliberately distinct from the store key: the two
   * live in different systems, and a shared spelling invites the assumption that one can be
   * derived from the other.
   */
  #lockKey(key: IdempotencyKey): string {
    return `${this.#keyPrefix}lock:${key}`;
  }
}

/**
 * Validates config (applying defaults) and returns an {@link IdempotencyManager}. The analogue of
 * the Go platform's `idempotencycfg.NewManager`, minus the nested store/locker config: both are
 * built by their own packages' factories and passed in, which is how this repo composes.
 *
 * The result type is the caller's, and it cannot be inferred from the arguments, so it is spelled
 * out at the call site: `provideIdempotencyManager<Receipt>(cfg, { store, lock })`.
 */
export function provideIdempotencyManager<T>(
  config: IdempotencyConfigInput | undefined,
  deps: IdempotencyDeps<T>,
): IdempotencyManager<T> {
  return new IdempotencyManager<T>(config, deps);
}
