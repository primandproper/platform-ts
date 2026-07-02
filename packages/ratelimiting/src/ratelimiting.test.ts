import { describe, expect, it } from "vitest";

import { MemoryRateLimiter } from "./providers/memory.js";
import { NoopRateLimiter } from "./providers/noop.js";
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
});
