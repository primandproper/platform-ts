import {
  makeRecordingObserver,
  type MeterProvider,
  type ObservabilityDeps,
} from "@primandproper/observability";
import { describe, expect, it } from "vitest";

import type { Cache } from "./cache.js";
import { InMemoryCache } from "./providers/memory.js";
import { NoopCache } from "./providers/noop.js";

/** A MeterProvider that records every counter `add`, so tests can assert hit/miss counters. */
function countingMeter(): { deps: ObservabilityDeps; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const meter = {
    createCounter: (name: string) => ({
      add: (value: number) => counts.set(name, (counts.get(name) ?? 0) + value),
    }),
    // makeObserver auto-mints an operation-duration histogram; the fake meter must provide it
    // even though these tests only assert on the counters.
    createHistogram: () => ({ record: () => undefined }),
    createUpDownCounter: () => ({ add: () => undefined }),
    createGauge: () => ({ record: () => undefined }),
  };
  const provider = { getMeter: () => meter } as unknown as MeterProvider;
  return { deps: { metrics: provider }, counts };
}

/** A TTL short enough to expire mid-test, and a wait comfortably past it. */
const SHORT_TTL_MS = 10;
const PAST_SHORT_TTL_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Provider-agnostic conformance suite. Running the same assertions against multiple
 * providers proves the `Cache<T>` interface is implementation-independent.
 */
function conformance(
  name: string,
  make: () => Cache<number>,
  opts: { readonly persists: boolean },
): void {
  describe(name, () => {
    it("returns undefined for a missing key", async () => {
      expect(await make().get("missing")).toBeUndefined();
    });

    it("round-trips a value", async () => {
      const cache = make();
      await cache.set("answer", 42);
      expect(await cache.get("answer")).toBe(opts.persists ? 42 : undefined);
    });

    it("deletes a stored value", async () => {
      const cache = make();
      await cache.set("k", 1);
      await cache.delete("k");
      expect(await cache.get("k")).toBeUndefined();
    });

    it("expires an entry written with a per-entry ttl", async () => {
      const cache = make();
      await cache.set("k", 1, { ttlMs: SHORT_TTL_MS });
      await sleep(PAST_SHORT_TTL_MS);
      expect(await cache.get("k")).toBeUndefined();
    });

    // The reason this issue exists: an idempotency claim (minutes) and its result record (a day)
    // are written through one cache instance, so a single cache-wide expiry cannot express them.
    it("keeps two entries with different ttls independent", async () => {
      const cache = make();
      await cache.set("claim", 1, { ttlMs: SHORT_TTL_MS });
      await cache.set("record", 2, { ttlMs: 60_000 });
      await sleep(PAST_SHORT_TTL_MS);

      expect(await cache.get("claim")).toBeUndefined();
      expect(await cache.get("record")).toBe(opts.persists ? 2 : undefined);
    });

    it("leaves an entry alone when no ttl is given and the cache configures none", async () => {
      const cache = make();
      await cache.set("k", 1);
      await sleep(PAST_SHORT_TTL_MS);
      expect(await cache.get("k")).toBe(opts.persists ? 1 : undefined);
    });

    it("pings without throwing", async () => {
      await expect(make().ping()).resolves.toBeUndefined();
    });

    it("closes without throwing", async () => {
      await expect(make().close()).resolves.toBeUndefined();
    });
  });
}

conformance("InMemoryCache", () => new InMemoryCache<number>(), { persists: true });
conformance("NoopCache", () => new NoopCache<number>(), { persists: false });

describe("InMemoryCache instrumentation", () => {
  it("counts a hit and a miss on get", async () => {
    const { deps, counts } = countingMeter();
    const cache = new InMemoryCache<number>({}, deps);

    await cache.set("answer", 42);
    expect(await cache.get("answer")).toBe(42);
    expect(await cache.get("missing")).toBeUndefined();

    expect(counts.get("cache.hits")).toBe(1);
    expect(counts.get("cache.misses")).toBe(1);
  });

  it("names the key on a miss", async () => {
    const observer = makeRecordingObserver();
    const cache = new InMemoryCache<number>({}, { observer });

    expect(await cache.get("nope")).toBeUndefined();

    expect(observer.forOperation("get")).toContainEqual(
      expect.objectContaining({ key: "key", value: "nope" }),
    );
  });
});

describe("InMemoryCache eviction (CACHE-2)", () => {
  it("caps entries and evicts the oldest-inserted when full", async () => {
    const cache = new InMemoryCache<number>({ maxEntries: 3 });
    await cache.set("a", 1);
    await cache.set("b", 2);
    await cache.set("c", 3);
    await cache.set("d", 4); // exceeds the cap; "a" (oldest) is evicted.

    expect(await cache.get("a")).toBeUndefined();
    expect(await cache.get("b")).toBe(2);
    expect(await cache.get("c")).toBe(3);
    expect(await cache.get("d")).toBe(4);
    // an evicted key comes back fresh.
    await cache.set("a", 9);
    expect(await cache.get("a")).toBe(9);
  });

  it("sweeps expired entries before evicting live ones", async () => {
    const cache = new InMemoryCache<number>({ maxEntries: 2, expiryMs: 1 });
    await cache.set("a", 1);
    await cache.set("b", 2);
    await new Promise((r) => setTimeout(r, 5)); // let a and b expire
    await cache.set("c", 3); // sweep reclaims a+b, no live eviction needed
    expect(await cache.get("c")).toBe(3);
  });

  it("stays unbounded when maxEntries is 0", async () => {
    const cache = new InMemoryCache<number>({ maxEntries: 0 });
    for (let i = 0; i < 50; i++) await cache.set(`k${String(i)}`, i);
    expect(await cache.get("k0")).toBe(0);
    expect(await cache.get("k49")).toBe(49);
  });
});

describe("InMemoryCache per-entry TTL", () => {
  it("overrides a shorter configured expiry", async () => {
    const cache = new InMemoryCache<number>({ expiryMs: SHORT_TTL_MS });
    await cache.set("k", 1, { ttlMs: 60_000 });
    await sleep(PAST_SHORT_TTL_MS);
    expect(await cache.get("k")).toBe(1);
  });

  // The documented rule: non-positive means "ignore me", NOT "never expire". Asserting both
  // values pins the choice, since the opposite reading is equally defensible in the abstract.
  it.each([0, -1])(
    "falls back to the configured expiry when ttlMs is %i",
    async (ttlMs) => {
      const cache = new InMemoryCache<number>({ expiryMs: SHORT_TTL_MS });
      await cache.set("k", 1, { ttlMs });
      await sleep(PAST_SHORT_TTL_MS);
      expect(await cache.get("k")).toBeUndefined();
    },
  );

  it("applies one ttl across a setMany batch", async () => {
    const cache = new InMemoryCache<number>();
    await cache.setMany(
      new Map([
        ["a", 1],
        ["b", 2],
      ]),
      { ttlMs: SHORT_TTL_MS },
    );
    expect(await cache.get("a")).toBe(1);
    await sleep(PAST_SHORT_TTL_MS);
    expect(await cache.getMany(["a", "b"])).toStrictEqual(new Map());
  });
});

describe("InMemoryCache value isolation (CACHE-3)", () => {
  it("does not let a caller mutate the cached copy after set or get", async () => {
    const cache = new InMemoryCache<{ n: number[] }>();
    const stored = { n: [1] };
    await cache.set("k", stored);
    stored.n.push(2); // mutate the caller's object after storing

    const read = await cache.get("k");
    expect(read).toStrictEqual({ n: [1] }); // unaffected by the post-set mutation

    read?.n.push(99); // mutate the read-back value
    const readAgain = await cache.get("k");
    expect(readAgain).toStrictEqual({ n: [1] }); // still unaffected
  });
});

describe("InMemoryCache batching", () => {
  it("omits missing keys from getMany", async () => {
    const cache = new InMemoryCache<number>();
    await cache.setMany(
      new Map([
        ["a", 1],
        ["b", 2],
      ]),
    );
    const found = await cache.getMany(["a", "b", "c"]);
    expect([...found.entries()]).toStrictEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });
});
