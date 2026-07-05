import {
  type LogValues,
  type Logger,
  type MeterProvider,
} from "@primandproper/observability";
import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";

import { RedisConfigSchema } from "./config.js";
import { MemoryRateLimiter } from "./providers/memory.js";
import { NoopRateLimiter } from "./providers/noop.js";
import { RedisRateLimiter } from "./providers/redis.node.js";
import type { RateLimiter } from "./ratelimiting.js";

const LIMIT = 3;
const WINDOW_MS = 1_000;

/**
 * Provider-agnostic conformance suite. Running the same assertions against multiple providers
 * proves the `RateLimiter` interface is implementation-independent. `enforces` distinguishes a
 * real limiter (denies past the ceiling) from the noop (always allows).
 */
function conformance(
  name: string,
  make: () => RateLimiter,
  opts: { readonly enforces: boolean },
): void {
  describe(name, () => {
    it("allows requests within the limit and decrements remaining", async () => {
      const limiter = make();
      const first = await limiter.limit("k");
      expect(first.allowed).toBe(true);
      expect(first.limit).toBe(LIMIT);
      expect(first.remaining).toBe(opts.enforces ? LIMIT - 1 : LIMIT);

      const second = await limiter.limit("k");
      expect(second.allowed).toBe(true);
      expect(second.remaining).toBe(opts.enforces ? LIMIT - 2 : LIMIT);
    });

    it("tracks keys independently", async () => {
      const limiter = make();
      await limiter.limit("a");
      const b = await limiter.limit("b");
      expect(b.remaining).toBe(opts.enforces ? LIMIT - 1 : LIMIT);
    });

    it("reset restores capacity without throwing", async () => {
      const limiter = make();
      await limiter.limit("k");
      await expect(limiter.reset("k")).resolves.toBeUndefined();
      const after = await limiter.limit("k");
      expect(after.remaining).toBe(opts.enforces ? LIMIT - 1 : LIMIT);
    });

    it("closes without throwing", async () => {
      await expect(make().close()).resolves.toBeUndefined();
    });
  });
}

conformance(
  "MemoryRateLimiter",
  () => new MemoryRateLimiter({ limit: LIMIT, windowMs: WINDOW_MS }),
  { enforces: true },
);
conformance("NoopRateLimiter", () => new NoopRateLimiter({ limit: LIMIT }), {
  enforces: false,
});

describe("MemoryRateLimiter enforcement", () => {
  it("denies the request past the limit with a positive retryAfterMs", async () => {
    const now = 1_000;
    const limiter = new MemoryRateLimiter(
      { limit: LIMIT, windowMs: WINDOW_MS },
      { now: () => now },
    );

    for (let i = 0; i < LIMIT; i++) {
      expect((await limiter.limit("k")).allowed).toBe(true);
    }

    const denied = await limiter.limit("k");
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.resetAt).toBe(now + WINDOW_MS);
  });

  it("restores capacity once the window elapses on the injected clock", async () => {
    let now = 1_000;
    const limiter = new MemoryRateLimiter(
      { limit: LIMIT, windowMs: WINDOW_MS },
      { now: () => now },
    );

    for (let i = 0; i < LIMIT; i++) {
      await limiter.limit("k");
    }
    expect((await limiter.limit("k")).allowed).toBe(false);

    // Advance past the window boundary; the next request opens a fresh window.
    now += WINDOW_MS;
    const fresh = await limiter.limit("k");
    expect(fresh.allowed).toBe(true);
    expect(fresh.remaining).toBe(LIMIT - 1);
  });

  it("accounts for cost greater than one", async () => {
    const now = 1_000;
    const limiter = new MemoryRateLimiter(
      { limit: LIMIT, windowMs: WINDOW_MS },
      { now: () => now },
    );

    const first = await limiter.limit("k", 2);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(1);

    // Only 1 unit left, a cost of 2 must be denied without consuming.
    const denied = await limiter.limit("k", 2);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(1);

    // A cost of 1 still fits.
    expect((await limiter.limit("k", 1)).allowed).toBe(true);
  });

  // RL-2: a negative (or fractional) cost would mint capacity — reject it.
  it("rejects a negative or non-integer cost", () => {
    const limiter = new MemoryRateLimiter({ limit: LIMIT, windowMs: WINDOW_MS });
    expect(() => limiter.limit("k", -5)).toThrow(/non-negative integer/);
    expect(() => limiter.limit("k", 1.5)).toThrow(/non-negative integer/);
  });

  // RL-1: tracked keys are bounded — the oldest is evicted rather than leaking forever.
  it("bounds tracked keys, evicting the oldest past maxKeys", async () => {
    const now = 1_000;
    const limiter = new MemoryRateLimiter(
      { limit: LIMIT, windowMs: WINDOW_MS, maxKeys: 2 },
      { now: () => now },
    );

    for (let i = 0; i < LIMIT; i++) {
      await limiter.limit("k1");
    }
    expect((await limiter.limit("k1")).allowed).toBe(false); // k1 exhausted

    // Two more distinct keys push past maxKeys=2, evicting the oldest-inserted (k1).
    await limiter.limit("k2");
    await limiter.limit("k3");

    // k1's window was evicted, so it starts fresh instead of leaking its exhausted state forever.
    const fresh = await limiter.limit("k1");
    expect(fresh.allowed).toBe(true);
    expect(fresh.remaining).toBe(LIMIT - 1);
  });
});

interface DebugLine {
  message: string;
  values: LogValues;
}

/** A logger that records debug lines with every value `with`/`child`/`withSpan` has accumulated. */
function recordingLogger(): { logger: Logger; debugs: DebugLine[] } {
  const debugs: DebugLine[] = [];
  const make = (bound: LogValues): Logger => ({
    debug: (message, values) => {
      debugs.push({ message, values: { ...bound, ...values } });
    },
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    with: (values) => make({ ...bound, ...values }),
    child: () => make(bound),
    withSpan: () => make(bound),
  });
  return { logger: make({}), debugs };
}

/** A meter provider that tallies counter `add`s by instrument name. */
function recordingMeter(): { provider: MeterProvider; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  const counter = (name: string) => ({
    add: (value: number) => {
      counts[name] = (counts[name] ?? 0) + value;
    },
  });
  const meter = {
    createCounter: (name: string) => counter(name),
    createUpDownCounter: (name: string) => counter(name),
    createHistogram: () => ({ record: () => undefined }),
    createGauge: () => ({ record: () => undefined }),
  };
  return {
    provider: { getMeter: () => meter } as unknown as MeterProvider,
    counts,
  };
}

describe("MemoryRateLimiter instrumentation", () => {
  it("increments the allowed counter on a permitted request", async () => {
    const { provider, counts } = recordingMeter();
    const limiter = new MemoryRateLimiter(
      { limit: LIMIT, windowMs: WINDOW_MS },
      { metrics: provider },
    );

    await limiter.limit("k");

    expect(counts["ratelimiting.allowed"]).toBe(1);
    expect(counts["ratelimiting.denied"] ?? 0).toBe(0);
  });

  it("names the key on the denial log and increments the denied counter", async () => {
    const now = 1_000;
    const { logger, debugs } = recordingLogger();
    const { provider, counts } = recordingMeter();
    const limiter = new MemoryRateLimiter(
      { limit: LIMIT, windowMs: WINDOW_MS },
      { now: () => now, logger, metrics: provider },
    );

    for (let i = 0; i < LIMIT; i++) {
      await limiter.limit("hot-key");
    }
    const denied = await limiter.limit("hot-key");
    expect(denied.allowed).toBe(false);

    expect(counts["ratelimiting.allowed"]).toBe(LIMIT);
    expect(counts["ratelimiting.denied"]).toBe(1);

    const denial = debugs.find((line) => line.message === "rate limit exceeded");
    expect(denial).toBeDefined();
    expect(denial?.values.key).toBe("hot-key");
  });
});

/** A fake ioredis client whose fixed-window command always rejects, to exercise the fail policy. */
function failingRedis(): Redis {
  return {
    defineCommand: () => undefined,
    rlFixedWindow: () => Promise.reject(new Error("redis down")),
  } as unknown as Redis;
}

describe("RedisRateLimiter fail policy (RL-3)", () => {
  it("fails closed by default when Redis errors — denies the request", async () => {
    const limiter = new RedisRateLimiter({
      url: "redis://localhost:6379",
      client: failingRedis(),
      limit: LIMIT,
      windowMs: WINDOW_MS,
    });
    const result = await limiter.limit("k");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBe(WINDOW_MS);
  });

  it("fails open when configured — admits the request", async () => {
    const limiter = new RedisRateLimiter({
      url: "redis://localhost:6379",
      client: failingRedis(),
      limit: LIMIT,
      windowMs: WINDOW_MS,
      failOpen: true,
    });
    const result = await limiter.limit("k");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(LIMIT);
  });
});

describe("RedisConfigSchema failOpen (RL-3)", () => {
  it("defaults failOpen to false (fail-closed)", () => {
    expect(RedisConfigSchema.parse({ url: "redis://localhost:6379" }).failOpen).toBe(
      false,
    );
  });

  it("accepts an explicit failOpen: true", () => {
    expect(
      RedisConfigSchema.parse({ url: "redis://localhost:6379", failOpen: true }).failOpen,
    ).toBe(true);
  });
});
