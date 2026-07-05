import { type Logger } from "@primandproper/observability";
import { describe, expect, it, vi } from "vitest";

import { RedisRateLimiter } from "./redis.node.js";

const LIMIT = 5;
const WINDOW_MS = 1_000;

const h = vi.hoisted(() => ({
  /** The Lua body ioredis was asked to register — lets us assert the script text without a live Redis. */
  lua: "",
  rlFixedWindow:
    vi.fn<(key: string, cost: number, windowMs: number) => Promise<[number, number]>>(),
  quit: vi.fn<() => Promise<"OK">>(() => Promise.resolve("OK")),
  disconnect: vi.fn<() => void>(),
}));

vi.mock("ioredis", () => {
  class Redis {
    defineCommand(name: string, opts: { numberOfKeys: number; lua: string }): void {
      h.lua = opts.lua;
      (this as unknown as Record<string, unknown>)[name] = h.rlFixedWindow;
    }
    del(): Promise<number> {
      return Promise.resolve(1);
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

interface ErrorLine {
  message: string;
  err: unknown;
}

/** A logger that records the error lines (message + wrapped cause) the provider emits. */
function recordingLogger(): { logger: Logger; errors: ErrorLine[] } {
  const errors: ErrorLine[] = [];
  const make = (): Logger => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (message: string, err?: unknown) => {
      errors.push({ message, err });
    },
    with: () => make(),
    child: () => make(),
    withSpan: () => make(),
  });
  return { logger: make(), errors };
}

describe("RedisRateLimiter TTL self-heal (RL-3)", () => {
  it("registers a Lua script that re-arms a counter with no expiry", () => {
    new RedisRateLimiter({ url: "redis://x", limit: LIMIT, windowMs: WINDOW_MS });

    // PTTL < 0 means the key has no TTL (-1) or is missing (-2); the script must PEXPIRE to re-arm it
    // so a counter that lost its expiry can never wedge the key at "denied" forever.
    expect(h.lua).toMatch(/PTTL/);
    expect(h.lua).toMatch(/if\s+pttl\s*<\s*0\s+then/);
    expect(h.lua).toMatch(/PEXPIRE/);
  });
});

describe("RedisRateLimiter fail policy (RL-3)", () => {
  it("fails closed by default — denies and wraps the redis error with context", async () => {
    h.rlFixedWindow.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const { logger, errors } = recordingLogger();
    const limiter = new RedisRateLimiter(
      { url: "redis://x", limit: LIMIT, windowMs: WINDOW_MS },
      { logger },
    );

    const result = await limiter.limit("k");

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterMs).toBe(WINDOW_MS);

    const line = errors.find((e) => e.message === "rate limiter redis error");
    expect(line).toBeDefined();
    expect((line?.err as Error).message).toMatch(
      /redis limit failed for k: ECONNREFUSED/,
    );
  });

  it("fails open when configured — admits at full capacity on a redis error", async () => {
    h.rlFixedWindow.mockRejectedValueOnce(new Error("ETIMEDOUT"));
    const limiter = new RedisRateLimiter({
      url: "redis://x",
      limit: LIMIT,
      windowMs: WINDOW_MS,
      failOpen: true,
    });

    const result = await limiter.limit("k");

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(LIMIT);
  });

  it("allows a request under the limit on the happy path", async () => {
    h.rlFixedWindow.mockResolvedValueOnce([1, WINDOW_MS]);
    const limiter = new RedisRateLimiter({
      url: "redis://x",
      limit: LIMIT,
      windowMs: WINDOW_MS,
    });

    const result = await limiter.limit("k");

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(LIMIT - 1);
  });
});
