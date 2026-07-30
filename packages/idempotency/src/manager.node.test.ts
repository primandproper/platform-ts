import { provideCache, type Cache } from "@primandproper/cache";
import {
  MemoryDistributedLock,
  NoopDistributedLock,
  type DistributedLock,
} from "@primandproper/distributedlock";
import { isPlatformError } from "@primandproper/errors";
import { makeRecordingObserver } from "@primandproper/observability";
import { describe, expect, it, vi } from "vitest";

import type { IdempotencyConfigInput } from "./config.js";
import { asFingerprint, IdempotencyErrorCode, parseIdempotencyKey } from "./key.js";
import {
  provideIdempotencyManager,
  type IdempotencyDeps,
  type IdempotencyManager,
} from "./manager.node.js";
import { RECORD_VERSION, type IdempotencyRecord } from "./record.js";

interface Receipt {
  chargeId: string;
  charged: boolean;
}

const KEY = parseIdempotencyKey("client-minted-key");
const FINGERPRINT = asFingerprint("fp-charge-100");
const OTHER_FINGERPRINT = asFingerprint("fp-charge-999");

/** A controllable clock, so claim expiry is exercised without real time passing. */
function fakeClock(start = 1_000_000): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

/**
 * A record store with a clock we control and failures we can switch on. The real memory cache
 * expires against `Date.now`, which claim-expiry tests need to move faster than.
 */
class FakeStore<T> implements Cache<T> {
  readonly entries = new Map<string, { value: T; expiresAt: number | undefined }>();
  /** When set, every read and write rejects with it — the store being unreachable. */
  failure: Error | undefined;
  readonly writes: T[] = [];

  constructor(private readonly now: () => number) {}

  get(key: string): Promise<T | undefined> {
    if (this.failure) return Promise.reject(this.failure);
    const entry = this.entries.get(key);
    if (entry === undefined) return Promise.resolve(undefined);
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(entry.value);
  }

  set(key: string, value: T, opts?: { ttlMs?: number }): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    this.writes.push(value);
    this.entries.set(key, {
      value,
      expiresAt:
        opts?.ttlMs !== undefined && opts.ttlMs > 0 ? this.now() + opts.ttlMs : undefined,
    });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    this.entries.delete(key);
    return Promise.resolve();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  /** The single record under test, whatever key prefix the manager applied. */
  only(): T | undefined {
    return [...this.entries.values()][0]?.value;
  }
}

/** The manager under test, wired to a fake clock and instant (fake) claim-lock polling. */
function makeManager<T = Receipt>(
  overrides: {
    config?: IdempotencyConfigInput;
    store?: Cache<IdempotencyRecord<T>>;
    lock?: DistributedLock;
    deps?: Partial<IdempotencyDeps<T>>;
    clock?: { now: () => number; advance: (ms: number) => void };
  } = {},
): {
  manager: IdempotencyManager<T>;
  store: Cache<IdempotencyRecord<T>>;
  clock: { now: () => number; advance: (ms: number) => void };
} {
  const clock = overrides.clock ?? fakeClock();
  const store = overrides.store ?? new FakeStore<IdempotencyRecord<T>>(clock.now);
  const manager = provideIdempotencyManager<T>(overrides.config, {
    store,
    lock: overrides.lock ?? new MemoryDistributedLock({}, { now: clock.now }),
    now: clock.now,
    // Waiting on a contended claim lock must not spend real time in tests; the clock still
    // advances so a wait budget is honoured.
    sleep: async (ms: number) => {
      clock.advance(ms);
    },
    ...overrides.deps,
  });
  return { manager, store, clock };
}

const receipt = (chargeId = "ch_1"): Receipt => ({ chargeId, charged: true });

describe("IdempotencyManager.run", () => {
  it("runs the work and reports it executed", async () => {
    const { manager } = makeManager();
    const work = vi.fn(() => receipt());

    await expect(manager.run(KEY, FINGERPRINT, work)).resolves.toEqual({
      status: "executed",
      value: receipt(),
    });
    expect(work).toHaveBeenCalledOnce();
  });

  it("replays a recorded result instead of running the work again", async () => {
    const { manager } = makeManager();
    const work = vi.fn(() => receipt());

    await manager.run(KEY, FINGERPRINT, work);
    const second = await manager.run(KEY, FINGERPRINT, work);

    expect(second).toEqual({ status: "replayed", value: receipt() });
    expect(work).toHaveBeenCalledOnce();
  });

  it("replays through real providers, not just the fake store", async () => {
    const manager = provideIdempotencyManager<Receipt>(undefined, {
      store: provideCache<IdempotencyRecord<Receipt>>({ provider: "memory" }),
      lock: new MemoryDistributedLock(),
    });
    const work = vi.fn(() => receipt());

    await manager.run(KEY, FINGERPRINT, work);

    await expect(manager.run(KEY, FINGERPRINT, work)).resolves.toEqual({
      status: "replayed",
      value: receipt(),
    });
    expect(work).toHaveBeenCalledOnce();
  });

  it("reports a fingerprint mismatch rather than replaying the earlier answer", async () => {
    const { manager } = makeManager();
    await manager.run(KEY, FINGERPRINT, () => receipt());
    const work = vi.fn(() => receipt("ch_2"));

    await expect(manager.run(KEY, OTHER_FINGERPRINT, work)).resolves.toEqual({
      status: "fingerprint-mismatch",
    });
    expect(work).not.toHaveBeenCalled();
  });

  it("reports a mismatch on a key reused mid-flight, in preference to in-flight", async () => {
    // A client reusing one key for two different requests has a bug worth surfacing now;
    // answering "in flight" would tell it to retry, which is the one thing that cannot help.
    const { manager, store } = makeManager();
    let release = (): void => undefined;
    const first = manager.run(
      KEY,
      FINGERPRINT,
      () =>
        new Promise<Receipt>((resolve) => {
          release = () => {
            resolve(receipt());
          };
        }),
    );
    await vi.waitFor(() => {
      expect((store as FakeStore<IdempotencyRecord<Receipt>>).only()?.state).toBe(
        "in-flight",
      );
    });

    await expect(manager.run(KEY, OTHER_FINGERPRINT, () => receipt())).resolves.toEqual({
      status: "fingerprint-mismatch",
    });

    release();
    await first;
  });

  it("refuses a second caller while the first is still running", async () => {
    const { manager, store } = makeManager();
    let release = (): void => undefined;
    const work = vi.fn(
      () =>
        new Promise<Receipt>((resolve) => {
          release = () => {
            resolve(receipt());
          };
        }),
    );

    const first = manager.run(KEY, FINGERPRINT, work);
    await vi.waitFor(() => {
      expect((store as FakeStore<IdempotencyRecord<Receipt>>).only()?.state).toBe(
        "in-flight",
      );
    });
    const second = await manager.run(KEY, FINGERPRINT, work);

    expect(second).toEqual({ status: "in-flight" });
    expect(work).toHaveBeenCalledOnce();

    release();
    await expect(first).resolves.toEqual({ status: "executed", value: receipt() });
  });

  it("lets only one of two concurrent callers execute", async () => {
    const { manager } = makeManager({ config: { lockWaitMs: 0 } });
    const work = vi.fn(async () => {
      await Promise.resolve();
      return receipt();
    });

    const [a, b] = await Promise.all([
      manager.run(KEY, FINGERPRINT, work),
      manager.run(KEY, FINGERPRINT, work),
    ]);

    expect(work).toHaveBeenCalledOnce();
    // One executes; the other is refused or replays, never a second execution.
    expect([a.status, b.status].sort()).toEqual(["executed", "in-flight"]);
  });

  it("releases the claim when the work throws, so the next attempt runs again", async () => {
    const { manager, store } = makeManager();
    const failing = vi.fn(() => {
      throw new Error("charge declined");
    });

    await expect(manager.run(KEY, FINGERPRINT, failing)).rejects.toThrow(
      "charge declined",
    );
    expect((store as FakeStore<IdempotencyRecord<Receipt>>).entries.size).toBe(0);

    await expect(manager.run(KEY, FINGERPRINT, () => receipt())).resolves.toEqual({
      status: "executed",
      value: receipt(),
    });
  });

  it("re-runs after the claim expires, and the stale execution cannot overwrite the new owner", async () => {
    // The one path left to a duplicate effect: work that outran inFlightTtlMs. What must not
    // also happen is the stale execution writing its result into a slot it no longer owns.
    const clock = fakeClock();
    const { manager, store } = makeManager({
      clock,
      config: { inFlightTtlMs: 1_000 },
      deps: {
        generateClaimId: (() => {
          let n = 0;
          return () => `claim-${String(++n)}`;
        })(),
      },
    });
    const fake = store as FakeStore<IdempotencyRecord<Receipt>>;
    let release = (): void => undefined;
    const slow = manager.run(
      KEY,
      FINGERPRINT,
      () =>
        new Promise<Receipt>((resolve) => {
          release = () => {
            resolve(receipt("ch_slow"));
          };
        }),
    );
    await vi.waitFor(() => {
      expect(fake.only()?.claimId).toBe("claim-1");
    });

    clock.advance(1_001);
    await expect(
      manager.run(KEY, FINGERPRINT, () => receipt("ch_fast")),
    ).resolves.toEqual({
      status: "executed",
      value: receipt("ch_fast"),
    });

    release();
    await expect(slow).resolves.toEqual({
      status: "executed",
      value: receipt("ch_slow"),
    });
    // The re-claimer's record survives: the stale execution skipped the write.
    expect(fake.only()).toMatchObject({
      claimId: "claim-2",
      state: "completed",
      value: receipt("ch_fast"),
    });
  });

  it("declines to record a result the recordable predicate rejects", async () => {
    // "That failure was ours, not theirs": pinning it for the whole TTL would strand a client
    // that could have succeeded on retry.
    const { manager, store } = makeManager({
      deps: { recordable: (value: Receipt) => value.charged },
    });
    const declined: Receipt = { chargeId: "", charged: false };

    await expect(manager.run(KEY, FINGERPRINT, () => declined)).resolves.toEqual({
      status: "executed",
      value: declined,
    });
    expect((store as FakeStore<IdempotencyRecord<Receipt>>).entries.size).toBe(0);

    await expect(manager.run(KEY, FINGERPRINT, () => receipt())).resolves.toEqual({
      status: "executed",
      value: receipt(),
    });
  });

  it("ignores a record written by another version rather than misreading it", async () => {
    const clock = fakeClock();
    const store = new FakeStore<IdempotencyRecord<Receipt>>(clock.now);
    await store.set("idempotency:" + KEY, {
      version: RECORD_VERSION + 1,
      state: "completed",
      createdAt: new Date(clock.now()).toISOString(),
      fingerprint: FINGERPRINT,
      claimId: "from-the-old-deploy",
      value: receipt("ch_old"),
    });
    const { manager } = makeManager({ clock, store });

    await expect(manager.run(KEY, FINGERPRINT, () => receipt("ch_new"))).resolves.toEqual(
      {
        status: "executed",
        value: receipt("ch_new"),
      },
    );
    expect(store.only()).toMatchObject({
      version: RECORD_VERSION,
      value: receipt("ch_new"),
    });
  });

  it("refuses a record in a state it does not understand", async () => {
    const clock = fakeClock();
    const store = new FakeStore<IdempotencyRecord<Receipt>>(clock.now);
    await store.set("idempotency:" + KEY, {
      version: RECORD_VERSION,
      state: "half-done" as IdempotencyRecord<Receipt>["state"],
      createdAt: new Date(clock.now()).toISOString(),
      fingerprint: FINGERPRINT,
      claimId: "c1",
    });
    const { manager } = makeManager({ clock, store });
    const work = vi.fn(() => receipt());

    await expect(manager.run(KEY, FINGERPRINT, work)).resolves.toEqual({
      status: "in-flight",
    });
    expect(work).not.toHaveBeenCalled();
  });

  it("writes the claim and the result with their own TTLs", async () => {
    const { manager, store } = makeManager({
      config: { inFlightTtlMs: 1_000, ttlMs: 60_000 },
    });
    const fake = store as FakeStore<IdempotencyRecord<Receipt>>;
    const setSpy = vi.spyOn(fake, "set");

    await manager.run(KEY, FINGERPRINT, () => receipt());

    expect(setSpy.mock.calls.map(([, , opts]) => opts?.ttlMs)).toEqual([1_000, 60_000]);
  });

  it("takes a per-call retention override", async () => {
    const { manager, store } = makeManager({ config: { ttlMs: 60_000 } });
    const setSpy = vi.spyOn(store as FakeStore<IdempotencyRecord<Receipt>>, "set");

    await manager.run(KEY, FINGERPRINT, () => receipt(), { ttlMs: 5_000 });

    expect(setSpy.mock.calls[1]?.[2]?.ttlMs).toBe(5_000);
  });

  it("rejects a key past the configured maximum before running anything", async () => {
    const { manager } = makeManager({ config: { maxKeyLength: 8 } });
    const work = vi.fn(() => receipt());

    await expect(
      manager.run(parseIdempotencyKey("way-too-long-to-accept"), FINGERPRINT, work),
    ).rejects.toSatisfy((err) => isPlatformError(err, IdempotencyErrorCode.keyTooLong));
    expect(work).not.toHaveBeenCalled();
  });

  it("rejects an empty fingerprint rather than defaulting it", async () => {
    // A default would make every request for a key look identical and disable mismatch
    // detection entirely.
    const { manager } = makeManager();
    const work = vi.fn(() => receipt());

    await expect(manager.run(KEY, asFingerprint(""), work)).rejects.toSatisfy((err) =>
      isPlatformError(err, IdempotencyErrorCode.fingerprintRequired),
    );
    expect(work).not.toHaveBeenCalled();
  });

  it("observes the key, the fingerprint, and the replay", async () => {
    const observer = makeRecordingObserver();
    const { manager } = makeManager({ deps: { observer } });

    await manager.run(KEY, FINGERPRINT, () => receipt());
    await manager.run(KEY, FINGERPRINT, () => receipt());

    expect(observer.observations).toContainEqual(
      expect.objectContaining({ key: "idempotency.key", value: KEY }),
    );
    expect(observer.observations).toContainEqual(
      expect.objectContaining({ key: "idempotency.replayed", value: true }),
    );
  });
});

describe("store failure policy", () => {
  it("fail-closed refuses the request rather than risking a duplicate effect", async () => {
    const clock = fakeClock();
    const store = new FakeStore<IdempotencyRecord<Receipt>>(clock.now);
    const { manager } = makeManager({ clock, store });
    store.failure = new Error("redis is down");
    const work = vi.fn(() => receipt());

    await expect(manager.run(KEY, FINGERPRINT, work)).rejects.toSatisfy((err) =>
      isPlatformError(err, IdempotencyErrorCode.storeUnavailable),
    );
    expect(work).not.toHaveBeenCalled();
  });

  it("fail-open treats a failed read as a miss and runs the work", async () => {
    const clock = fakeClock();
    const store = new FakeStore<IdempotencyRecord<Receipt>>(clock.now);
    // Reads fail, writes still land — the shape fail-open exists for.
    vi.spyOn(store, "get").mockRejectedValue(new Error("redis read timeout"));
    const { manager } = makeManager({
      clock,
      store,
      config: { storeFailurePolicy: "fail-open" },
    });
    const work = vi.fn(() => receipt());

    await expect(manager.run(KEY, FINGERPRINT, work)).resolves.toEqual({
      status: "executed",
      value: receipt(),
    });
    expect(work).toHaveBeenCalledOnce();
  });

  it("refuses a failed claim write under either policy — the policy governs reads only", async () => {
    // A claim that could not be written leaves the completion nothing to prove ownership
    // against, so there is no state in which running the work is a defensible guess. Matching
    // platform-go, which lets a Set failure fail the request regardless of FailOpen.
    for (const storeFailurePolicy of ["fail-closed", "fail-open"] as const) {
      const clock = fakeClock();
      const store = new FakeStore<IdempotencyRecord<Receipt>>(clock.now);
      vi.spyOn(store, "set").mockRejectedValue(new Error("redis is down"));
      const { manager } = makeManager({ clock, store, config: { storeFailurePolicy } });
      const work = vi.fn(() => receipt());

      await expect(manager.run(KEY, FINGERPRINT, work)).rejects.toSatisfy((err) =>
        isPlatformError(err, IdempotencyErrorCode.storeUnavailable),
      );
      expect(work).not.toHaveBeenCalled();
    }
  });

  it("refuses when the locker itself fails, under either policy", async () => {
    const lock: DistributedLock = {
      acquire: () => Promise.reject(new Error("lock store down")),
      ping: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };

    for (const storeFailurePolicy of ["fail-closed", "fail-open"] as const) {
      const { manager } = makeManager({ lock, config: { storeFailurePolicy } });
      const work = vi.fn(() => receipt());

      await expect(manager.run(KEY, FINGERPRINT, work)).rejects.toSatisfy((err) =>
        isPlatformError(err, IdempotencyErrorCode.storeUnavailable),
      );
      expect(work).not.toHaveBeenCalled();
    }
  });

  it("fail-open on a wholly unreachable store still refuses, because the claim cannot land", async () => {
    const clock = fakeClock();
    const store = new FakeStore<IdempotencyRecord<Receipt>>(clock.now);
    const { manager } = makeManager({
      clock,
      store,
      config: { storeFailurePolicy: "fail-open" },
    });
    store.failure = new Error("redis is down");
    const work = vi.fn(() => receipt());

    await expect(manager.run(KEY, FINGERPRINT, work)).rejects.toSatisfy((err) =>
      isPlatformError(err, IdempotencyErrorCode.storeUnavailable),
    );
    expect(work).not.toHaveBeenCalled();
  });

  it("keeps the store error as the cause, so the operator can see what broke", async () => {
    const clock = fakeClock();
    const store = new FakeStore<IdempotencyRecord<Receipt>>(clock.now);
    const { manager } = makeManager({ clock, store });
    const cause = new Error("ECONNREFUSED");
    store.failure = cause;

    await expect(manager.run(KEY, FINGERPRINT, () => receipt())).rejects.toMatchObject({
      cause,
    });
  });
});

describe("the locker matters", () => {
  it("still replays under the noop locker — but grants every claim", async () => {
    // Documented, not endorsed: replay covers the ordinary timeout-then-retry case, while two
    // genuinely concurrent requests can both claim and both execute.
    const { manager } = makeManager({ lock: new NoopDistributedLock() });

    await manager.run(KEY, FINGERPRINT, () => receipt());

    await expect(manager.run(KEY, FINGERPRINT, () => receipt())).resolves.toEqual({
      status: "replayed",
      value: receipt(),
    });
  });
});
