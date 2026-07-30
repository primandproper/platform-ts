import { describe, expect, it, vi } from "vitest";

import { RedisCache } from "./redis.node.js";

const h = vi.hoisted(() => ({
  store: new Map<string, string>(),
  del: vi.fn<(key: string | string[]) => void>(),
  /** Records the full argument list of every SET, so TTL flags can be asserted. */
  set: vi.fn<(...args: unknown[]) => void>(),
  quit: vi.fn<() => Promise<"OK">>(() => Promise.resolve("OK")),
  disconnect: vi.fn<() => void>(),
}));

vi.mock("ioredis", () => {
  class Redis {
    get(key: string): Promise<string | null> {
      return Promise.resolve(h.store.get(key) ?? null);
    }
    mget(keys: string[]): Promise<(string | null)[]> {
      return Promise.resolve(keys.map((key) => h.store.get(key) ?? null));
    }
    del(key: string | string[]): Promise<number> {
      h.del(key);
      const keys = Array.isArray(key) ? key : [key];
      let count = 0;
      for (const k of keys) {
        if (h.store.delete(k)) count += 1;
      }
      return Promise.resolve(count);
    }
    set(key: string, value: string, ...rest: unknown[]): Promise<"OK"> {
      h.set(key, value, ...rest);
      h.store.set(key, value);
      return Promise.resolve("OK");
    }
    pipeline(): {
      set: (key: string, value: string, ...rest: unknown[]) => unknown;
      exec: () => Promise<[Error | null, unknown][]>;
    } {
      const queued: [string, string][] = [];
      const p = {
        set: (key: string, value: string, ...rest: unknown[]): unknown => {
          h.set(key, value, ...rest);
          queued.push([key, value]);
          return p;
        },
        exec: (): Promise<[Error | null, unknown][]> => {
          for (const [key, value] of queued) h.store.set(key, value);
          return Promise.resolve(
            queued.map(() => [null, "OK"] as [Error | null, unknown]),
          );
        },
      };
      return p;
    }
    ping(): Promise<"PONG"> {
      return Promise.resolve("PONG");
    }
    quit(): Promise<"OK"> {
      return h.quit();
    }
    disconnect(): void {
      h.disconnect();
    }
  }
  return { Redis };
});

describe("RedisCache corrupt entry (CACHE-1)", () => {
  it("degrades a corrupt entry to a miss and deletes it", async () => {
    h.store.set("k", "not json{");
    const cache = new RedisCache<number>({ url: "redis://x" });

    expect(await cache.get("k")).toBeUndefined();
    expect(h.del).toHaveBeenCalledWith("k");
  });

  it("wraps an encoding failure on set with context", async () => {
    const cache = new RedisCache<unknown>({ url: "redis://x" });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(cache.set("k", circular)).rejects.toThrow(
      /failed to encode value for k/,
    );
  });
});

describe("RedisCache batching (PERF-1)", () => {
  it("getMany returns hits via MGET and omits misses", async () => {
    h.store.clear();
    h.store.set("a", JSON.stringify(1));
    h.store.set("c", JSON.stringify(3));
    const cache = new RedisCache<number>({ url: "redis://x" });

    const found = await cache.getMany(["a", "b", "c"]);

    expect(found.get("a")).toBe(1);
    expect(found.get("c")).toBe(3);
    expect(found.has("b")).toBe(false); // a miss is omitted
    expect(found.size).toBe(2);
  });

  it("getMany drops a corrupt entry, counting it as a miss", async () => {
    h.store.clear();
    h.store.set("a", JSON.stringify(1));
    h.store.set("bad", "not json{");
    h.del.mockClear();
    const cache = new RedisCache<number>({ url: "redis://x" });

    const found = await cache.getMany(["a", "bad"]);

    expect(found.get("a")).toBe(1);
    expect(found.has("bad")).toBe(false);
    expect(h.del).toHaveBeenCalledWith(["bad"]); // corrupt key deleted
  });

  it("setMany writes every item via a pipeline", async () => {
    h.store.clear();
    const cache = new RedisCache<number>({ url: "redis://x" });

    await cache.setMany(
      new Map([
        ["x", 10],
        ["y", 20],
      ]),
    );

    expect(h.store.get("x")).toBe(JSON.stringify(10));
    expect(h.store.get("y")).toBe(JSON.stringify(20));
  });

  it("setMany wraps an encoding failure with context", async () => {
    const cache = new RedisCache<unknown>({ url: "redis://x" });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(cache.setMany(new Map([["k", circular]]))).rejects.toThrow(
      /failed to encode value for k/,
    );
  });
});

describe("RedisCache per-entry TTL", () => {
  it("sends no expiry flag when neither a default nor an override is set", async () => {
    h.set.mockClear();
    const cache = new RedisCache<number>({ url: "redis://x" });

    await cache.set("k", 1);

    expect(h.set).toHaveBeenCalledWith("k", "1");
  });

  it("sends the configured default expiry as PX milliseconds", async () => {
    h.set.mockClear();
    const cache = new RedisCache<number>({ url: "redis://x", expiryMs: 60_000 });

    await cache.set("k", 1);

    expect(h.set).toHaveBeenCalledWith("k", "1", "PX", 60_000);
  });

  // PX rather than EX: the interface is denominated in milliseconds, and EX would round this
  // 1500ms TTL up to a whole 2s.
  it("sends a per-entry override at millisecond precision", async () => {
    h.set.mockClear();
    const cache = new RedisCache<number>({ url: "redis://x", expiryMs: 60_000 });

    await cache.set("k", 1, { ttlMs: 1500 });

    expect(h.set).toHaveBeenCalledWith("k", "1", "PX", 1500);
  });

  it("falls back to the configured expiry when ttlMs is non-positive", async () => {
    h.set.mockClear();
    const cache = new RedisCache<number>({ url: "redis://x", expiryMs: 60_000 });

    await cache.set("k", 1, { ttlMs: 0 });

    expect(h.set).toHaveBeenCalledWith("k", "1", "PX", 60_000);
  });

  it("applies the prefix and one ttl to every write in a setMany batch", async () => {
    h.set.mockClear();
    const cache = new RedisCache<number>({ url: "redis://x", keyPrefix: "p:" });

    await cache.setMany(
      new Map([
        ["x", 10],
        ["y", 20],
      ]),
      { ttlMs: 5_000 },
    );

    expect(h.set).toHaveBeenCalledWith("p:x", "10", "PX", 5_000);
    expect(h.set).toHaveBeenCalledWith("p:y", "20", "PX", 5_000);
  });
});

describe("RedisCache close (LC-1)", () => {
  it("quits an owned client on close", async () => {
    h.quit.mockClear();
    h.disconnect.mockClear();
    const cache = new RedisCache<number>({ url: "redis://x" });

    await cache.close();

    expect(h.quit).toHaveBeenCalledOnce();
    expect(h.disconnect).not.toHaveBeenCalled();
  });

  it("falls back to disconnect when quit rejects", async () => {
    h.quit.mockClear();
    h.disconnect.mockClear();
    h.quit.mockRejectedValueOnce(new Error("quit failed"));
    const cache = new RedisCache<number>({ url: "redis://x" });

    await expect(cache.close()).resolves.toBeUndefined();
    expect(h.disconnect).toHaveBeenCalledOnce();
  });

  it("leaves an injected client open — the caller owns its lifecycle", async () => {
    h.quit.mockClear();
    h.disconnect.mockClear();
    const { Redis } = await import("ioredis");
    const shared = new Redis("redis://shared");
    const cache = new RedisCache<number>({ url: "unused", client: shared });

    await cache.close();

    expect(h.quit).not.toHaveBeenCalled();
    expect(h.disconnect).not.toHaveBeenCalled();
  });
});
