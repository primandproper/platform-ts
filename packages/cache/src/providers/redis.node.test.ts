import { describe, expect, it, vi } from "vitest";

import { RedisCache } from "./redis.node.js";

const h = vi.hoisted(() => ({
  store: new Map<string, string>(),
  del: vi.fn<(key: string | string[]) => void>(),
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
    set(): Promise<"OK"> {
      return Promise.resolve("OK");
    }
    pipeline(): {
      set: (key: string, value: string, ...rest: unknown[]) => unknown;
      exec: () => Promise<[Error | null, unknown][]>;
    } {
      const queued: [string, string][] = [];
      const p = {
        set: (key: string, value: string): unknown => {
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
