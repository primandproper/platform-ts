import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { MemoryDistributedLock } from "./providers/memory.js";
import { NoopDistributedLock } from "./providers/noop.js";
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

    it("releases without throwing", async () => {
      const lock = await make().acquire("job");
      await expect(lock?.release()).resolves.toBeUndefined();
    });

    it("refreshes without throwing", async () => {
      const lock = await make().acquire("job");
      await expect(lock?.refresh()).resolves.toBeUndefined();
    });

    it("pings without throwing", async () => {
      await expect(make().ping()).resolves.toBeUndefined();
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

    await stale?.release(); // must not free fresh's lease
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

    await stale?.release(); // must not free fresh's lease
    expect(await dl.acquire("job")).toBeUndefined();
  });

  it("does not refresh someone else's lock after losing the lease", async () => {
    const clock = fakeClock();
    const dl = new MemoryDistributedLock({}, { now: clock.now });

    const stale = await dl.acquire("job", { ttlMs: 1_000 });
    clock.advance(1_000);
    const fresh = await dl.acquire("job", { ttlMs: 1_000 });
    expect(fresh).toBeDefined();

    await stale?.refresh(10_000); // must not touch fresh's lease

    clock.advance(1_000); // fresh's own lease lapses
    expect(await dl.acquire("job")).toBeDefined();
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
