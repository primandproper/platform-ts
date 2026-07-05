import { randomUUID } from "node:crypto";

import { makeRecordingObserver } from "@primandproper/observability";
import { describe, expect, it } from "vitest";

import { MemoryDistributedLock } from "./providers/memory.js";
import { NoopDistributedLock } from "./providers/noop.js";
import { PostgresDistributedLock } from "./providers/postgres.node.js";
import { RedisDistributedLock } from "./providers/redis.node.js";

import { provideDistributedLock, type DistributedLock } from "./index.js";

/**
 * Live-Redis integration is opt-in: set DISTRIBUTEDLOCK_TEST_REDIS_URL to a reachable Redis
 * (e.g. redis://localhost:6379) to run the conformance + cross-process suites against it. The
 * default offline run skips them and stays green. Each instance gets a unique key prefix so
 * concurrent/leftover keys never collide on a shared server.
 */
const REDIS_URL = process.env.DISTRIBUTEDLOCK_TEST_REDIS_URL;

/** A controllable clock for deterministic ttl/expiry tests. */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

/**
 * Provider-agnostic conformance suite. Running the same assertions against multiple providers
 * proves the `DistributedLock` interface is implementation-independent.
 */
function conformance(name: string, make: () => DistributedLock): void {
  describe(name, () => {
    it("acquires a free key", async () => {
      const lock = await make().acquire("job");
      expect(lock).toBeDefined();
      expect(lock?.key).toBe("job");
    });

    it("release of an owned lease reports true", async () => {
      const lock = await make().acquire("job");
      await expect(lock?.release()).resolves.toBe(true);
    });

    it("refresh of an owned lease reports true", async () => {
      const lock = await make().acquire("job");
      await expect(lock?.refresh()).resolves.toBe(true);
    });

    it("pings without throwing", async () => {
      await expect(make().ping()).resolves.toBeUndefined();
    });

    it("closes without throwing", async () => {
      await expect(make().close()).resolves.toBeUndefined();
    });
  });
}

conformance("MemoryDistributedLock", () => new MemoryDistributedLock());
conformance("NoopDistributedLock", () => new NoopDistributedLock());

const redisLock = (): RedisDistributedLock =>
  new RedisDistributedLock({
    url: REDIS_URL ?? "redis://localhost:6379",
    keyPrefix: `dltest:${randomUUID()}:`,
  });

describe.skipIf(!REDIS_URL)("RedisDistributedLock (live)", () => {
  conformance("RedisDistributedLock", redisLock);

  it("grants a contended key undefined while held", async () => {
    const dl = redisLock();
    const first = await dl.acquire("job", { ttlMs: 5_000 });
    expect(first).toBeDefined();
    expect(await dl.acquire("job", { ttlMs: 5_000 })).toBeUndefined();
  });

  it("frees the key on release so it can be re-acquired", async () => {
    const dl = redisLock();
    const first = await dl.acquire("job", { ttlMs: 5_000 });
    expect(first).toBeDefined();

    await first?.release();
    expect(await dl.acquire("job", { ttlMs: 5_000 })).toBeDefined();
  });

  it("does not free a key whose lease was taken over", async () => {
    const dl = redisLock();
    const stale = await dl.acquire("job", { ttlMs: 200 });
    expect(stale).toBeDefined();

    await new Promise((r) => setTimeout(r, 300)); // stale's lease expires
    const fresh = await dl.acquire("job", { ttlMs: 5_000 });
    expect(fresh).toBeDefined();

    expect(await stale?.release()).toBe(false); // reports the loss; must not free fresh's lease
    expect(await dl.acquire("job", { ttlMs: 5_000 })).toBeUndefined();
  });
});

describe("MemoryDistributedLock", () => {
  it("grants a second acquire of the same key undefined while held", async () => {
    const dl = new MemoryDistributedLock();
    const first = await dl.acquire("job");
    expect(first).toBeDefined();
    expect(await dl.acquire("job")).toBeUndefined();
  });

  it("frees the key on release so it can be re-acquired", async () => {
    const dl = new MemoryDistributedLock();
    const first = await dl.acquire("job");
    expect(first).toBeDefined();

    await first?.release();
    expect(await dl.acquire("job")).toBeDefined();
  });

  it("auto-expires a lease after its ttl", async () => {
    const clock = fakeClock();
    const dl = new MemoryDistributedLock({}, { now: clock.now });

    const first = await dl.acquire("job", { ttlMs: 1_000 });
    expect(first).toBeDefined();
    expect(await dl.acquire("job")).toBeUndefined();

    clock.advance(999);
    expect(await dl.acquire("job")).toBeUndefined();

    clock.advance(1); // total 1000ms == ttl
    expect(await dl.acquire("job")).toBeDefined();
  });

  it("refresh extends the lease past its original expiry", async () => {
    const clock = fakeClock();
    const dl = new MemoryDistributedLock({}, { now: clock.now });

    const lock = await dl.acquire("job", { ttlMs: 1_000 });
    expect(lock).toBeDefined();

    clock.advance(900);
    await lock?.refresh(1_000); // expiry now at 1900

    clock.advance(200); // total 1100ms; original ttl would have lapsed
    expect(await dl.acquire("job")).toBeUndefined();
  });

  it("does not free someone else's lock after losing the lease", async () => {
    const clock = fakeClock();
    const dl = new MemoryDistributedLock({}, { now: clock.now });

    const stale = await dl.acquire("job", { ttlMs: 1_000 });
    expect(stale).toBeDefined();

    clock.advance(1_000); // stale's lease expires
    const fresh = await dl.acquire("job", { ttlMs: 1_000 });
    expect(fresh).toBeDefined();

    expect(await stale?.release()).toBe(false); // reports the loss; must not free fresh's lease
    expect(await dl.acquire("job")).toBeUndefined();
  });

  it("does not refresh someone else's lock after losing the lease", async () => {
    const clock = fakeClock();
    const dl = new MemoryDistributedLock({}, { now: clock.now });

    const stale = await dl.acquire("job", { ttlMs: 1_000 });
    clock.advance(1_000);
    const fresh = await dl.acquire("job", { ttlMs: 1_000 });
    expect(fresh).toBeDefined();

    expect(await stale?.refresh(10_000)).toBe(false); // reports the loss; must not touch fresh's lease

    clock.advance(1_000); // fresh's own lease lapses
    expect(await dl.acquire("job")).toBeDefined();
  });

  // DL-1: refresh must not revive a lease that lapsed on the clock, even with no takeover.
  it("refresh reports loss and does not revive an expired-but-untaken lease", async () => {
    const clock = fakeClock();
    const dl = new MemoryDistributedLock({}, { now: clock.now });

    const lock = await dl.acquire("job", { ttlMs: 1_000 });
    expect(lock).toBeDefined();

    clock.advance(1_000); // lease lapses; nobody else has taken it
    expect(await lock?.refresh()).toBe(false);

    // The key is free (refresh did not resurrect the dead lease), so a fresh acquire succeeds.
    expect(await dl.acquire("job")).toBeDefined();
  });

  // DL-2: an abandoned expired lease must not linger in the map forever — a later acquire sweeps it.
  it("sweeps abandoned expired leases on a subsequent acquire", async () => {
    const clock = fakeClock();
    const observer = makeRecordingObserver();
    const dl = new MemoryDistributedLock({}, { now: clock.now, observer });

    // Acquire and abandon a key (never released), then let its lease lapse.
    expect(await dl.acquire("abandoned", { ttlMs: 1_000 })).toBeDefined();
    clock.advance(1_000);

    // Acquiring an unrelated key triggers the opportunistic sweep, dropping the dead "abandoned" row.
    observer.reset();
    expect(await dl.acquire("other", { ttlMs: 1_000 })).toBeDefined();
    expect(observer.data()["leases.swept"]).toBe(1);
  });
});

describe("observability (INST-2)", () => {
  it("runs acquire/release/refresh inside the injected observer, keyed by the lock key", async () => {
    const observer = makeRecordingObserver();
    const dl = new MemoryDistributedLock({}, { observer });

    const lock = await dl.acquire("job");
    expect(lock).toBeDefined();
    await lock?.refresh();
    await lock?.release();

    // The factory-style spans are named and each carries the key on both pillars.
    expect(observer.runs.map((r) => r.operation)).toEqual([
      "acquire",
      "refresh",
      "release",
    ]);
    for (const op of ["acquire", "refresh", "release"]) {
      const keyObs = observer.forOperation(op).find((o) => o.key === "key");
      expect(keyObs, `${op} must name the key`).toBeDefined();
      expect(keyObs?.value).toBe("job");
      expect(keyObs?.pillar).toBe("both"); // fans to span AND log
    }
  });

  it("names the key when acquire is contended", async () => {
    const observer = makeRecordingObserver();
    const dl = new MemoryDistributedLock({}, { observer });

    expect(await dl.acquire("job")).toBeDefined();
    expect(await dl.acquire("job")).toBeUndefined(); // contended

    const contendedAcquire = observer
      .forOperation("acquire")
      .filter((o) => o.key === "key" && o.value === "job");
    expect(contendedAcquire.length).toBe(2); // both attempts named the key
  });

  it("names the key when release/refresh find the lease lost", async () => {
    const clock = fakeClock();
    const observer = makeRecordingObserver();
    const dl = new MemoryDistributedLock({}, { now: clock.now, observer });

    const stale = await dl.acquire("job", { ttlMs: 1_000 });
    clock.advance(1_000); // lease lapses
    await dl.acquire("job", { ttlMs: 1_000 }); // taken over

    expect(await stale?.release()).toBe(false);
    expect(await stale?.refresh()).toBe(false);

    for (const op of ["release", "refresh"]) {
      const keyObs = observer.forOperation(op).find((o) => o.key === "key");
      expect(keyObs?.value).toBe("job");
    }
  });

  it("provideDistributedLock threads an injected observer to the provider", async () => {
    const observer = makeRecordingObserver();
    const dl = provideDistributedLock({ provider: "memory" }, { observer });

    await dl.acquire("job");

    expect(observer.forOperation("acquire").some((o) => o.key === "key")).toBe(true);
  });
});

describe("provideDistributedLock", () => {
  it("defaults to the memory provider", () => {
    expect(provideDistributedLock()).toBeInstanceOf(MemoryDistributedLock);
  });

  it("builds a noop lock when requested", () => {
    expect(provideDistributedLock({ provider: "noop" })).toBeInstanceOf(
      NoopDistributedLock,
    );
  });

  it("builds a redis lock when configured", () => {
    expect(
      provideDistributedLock({
        provider: "redis",
        redis: { url: "redis://localhost:6379" },
      }),
    ).toBeInstanceOf(RedisDistributedLock);
  });

  it("rejects redis provider without redis config", () => {
    expect(() => provideDistributedLock({ provider: "redis" })).toThrow();
  });

  it("noop always grants, even for a contended key", async () => {
    const dl = provideDistributedLock({ provider: "noop" });
    expect(await dl.acquire("job")).toBeDefined();
    expect(await dl.acquire("job")).toBeDefined();
  });

  it("applies the configured default ttl", async () => {
    const clock = fakeClock();
    const dl = provideDistributedLock(
      { provider: "memory", memory: { defaultTtlMs: 1_000 } },
      { now: clock.now },
    );

    expect(await dl.acquire("job")).toBeDefined();
    expect(await dl.acquire("job")).toBeUndefined();

    clock.advance(1_000);
    expect(await dl.acquire("job")).toBeDefined();
  });
});

// DL-2: the postgres provider reclaims abandoned expired rows via a maintenance call. (The full
// acquire/release lifecycle against a live postgres is exercised separately, behind an env flag.)
describe("PostgresDistributedLock.cleanupExpired (DL-2)", () => {
  it("deletes rows whose lease has lapsed and returns the count", async () => {
    const queries: string[] = [];
    const pool = {
      query: (text: string) => {
        queries.push(text);
        return Promise.resolve({ rows: [], rowCount: 3 });
      },
      end: () => Promise.resolve(),
    };
    const dl = new PostgresDistributedLock({ pool });

    await expect(dl.cleanupExpired()).resolves.toBe(3);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(
      /DELETE FROM distributed_locks WHERE expires_at < now\(\)/,
    );
  });
});
