import { describe, expect, it } from "vitest";

import { WebStorageCache } from "./web.browser.js";

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length(): number {
      return m.size;
    },
    clear: () => {
      m.clear();
    },
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => {
      m.delete(k);
    },
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
  };
}

describe("WebStorageCache corrupt entry (CACHE-1)", () => {
  it("degrades a corrupt entry to a miss and drops it", async () => {
    const storage = fakeStorage();
    const cache = new WebStorageCache<number>({ namespace: "ns", storage });

    storage.setItem("ns:k", "}{ not json");

    expect(await cache.get("k")).toBeUndefined();
    // The poisoned entry is removed so the next read is a clean miss rather than a repeat throw.
    expect(storage.getItem("ns:k")).toBeNull();
  });

  it("still round-trips a valid entry", async () => {
    const cache = new WebStorageCache<number>({ storage: fakeStorage() });
    await cache.set("k", 7);
    expect(await cache.get("k")).toBe(7);
  });
});

describe("WebStorageCache per-entry TTL", () => {
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it("expires an entry at its own ttl and drops it from storage", async () => {
    const storage = fakeStorage();
    const cache = new WebStorageCache<number>({ namespace: "ns", storage });

    await cache.set("k", 1, { ttlMs: 10 });
    await sleep(50);

    expect(await cache.get("k")).toBeUndefined();
    expect(storage.getItem("ns:k")).toBeNull(); // the expired entry is reclaimed, not just hidden
  });

  it("keeps a long-lived entry while a short-lived one expires", async () => {
    const cache = new WebStorageCache<number>({ storage: fakeStorage() });

    await cache.set("claim", 1, { ttlMs: 10 });
    await cache.set("record", 2, { ttlMs: 60_000 });
    await sleep(50);

    expect(await cache.get("claim")).toBeUndefined();
    expect(await cache.get("record")).toBe(2);
  });

  it("falls back to the configured expiry when ttlMs is non-positive", async () => {
    const cache = new WebStorageCache<number>({ storage: fakeStorage(), expiryMs: 10 });

    await cache.set("k", 1, { ttlMs: 0 });
    await sleep(50);

    expect(await cache.get("k")).toBeUndefined();
  });
});

describe("WebStorageCache quota handling (CACHE-3)", () => {
  it("degrades a QuotaExceededError to a skipped set instead of throwing", async () => {
    const storage = fakeStorage();
    storage.setItem = () => {
      const err = new Error("quota") as Error & { name: string };
      err.name = "QuotaExceededError";
      throw err;
    };
    const cache = new WebStorageCache<number>({ storage });
    await expect(cache.set("k", 1)).resolves.toBeUndefined();
  });

  it("rethrows a non-quota storage error", async () => {
    const storage = fakeStorage();
    storage.setItem = () => {
      throw new Error("disk on fire");
    };
    const cache = new WebStorageCache<number>({ storage });
    await expect(cache.set("k", 1)).rejects.toThrow(/disk on fire/);
  });
});
