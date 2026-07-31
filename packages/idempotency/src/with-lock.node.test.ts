import { MemoryDistributedLock } from "@primandproper/distributedlock";
import { describe, expect, it, vi } from "vitest";

import { withLock } from "./with-lock.node.js";

/** A controllable clock, so wait budgets are exercised without real time passing. */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

describe("withLock", () => {
  it("runs the callback while holding the lock and reports its value", async () => {
    const lock = new MemoryDistributedLock();

    const attempt = await withLock(lock, "k", async (held) => {
      expect(held.key).toBe("k");
      // Held for the duration of the callback: nobody else may take it.
      await expect(lock.acquire("k")).resolves.toBeUndefined();
      return "done";
    });

    expect(attempt).toEqual({ acquired: true, value: "done" });
  });

  it("releases the lock afterwards", async () => {
    const lock = new MemoryDistributedLock();

    await withLock(lock, "k", () => undefined);

    await expect(lock.acquire("k")).resolves.toBeDefined();
  });

  it("releases the lock when the callback throws, and propagates the error", async () => {
    const lock = new MemoryDistributedLock();

    await expect(
      withLock(lock, "k", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(lock.acquire("k")).resolves.toBeDefined();
  });

  it("reports contention rather than throwing", async () => {
    const lock = new MemoryDistributedLock();
    await lock.acquire("k");

    await expect(withLock(lock, "k", () => "unreachable")).resolves.toEqual({
      acquired: false,
    });
  });

  it("retries a held key until the wait budget is spent", async () => {
    const lock = new MemoryDistributedLock();
    await lock.acquire("k");
    const clock = fakeClock();
    const sleep = vi.fn(async (ms: number) => {
      clock.advance(ms);
    });

    const attempt = await withLock(lock, "k", () => "unreachable", {
      waitMs: 100,
      pollMs: 25,
      now: clock.now,
      sleep,
    });

    expect(attempt).toEqual({ acquired: false });
    // 4 sleeps of 25ms exhaust the 100ms budget; the 5th attempt finds the deadline reached.
    expect(sleep).toHaveBeenCalledTimes(4);
  });

  it("acquires on a later attempt when the holder releases", async () => {
    const lock = new MemoryDistributedLock();
    const held = await lock.acquire("k");
    const clock = fakeClock();
    let attempts = 0;
    const sleep = async (ms: number): Promise<void> => {
      clock.advance(ms);
      attempts += 1;
      if (attempts === 2) {
        await held?.release();
      }
    };

    await expect(
      withLock(lock, "k", () => "done", {
        waitMs: 1_000,
        pollMs: 25,
        now: clock.now,
        sleep,
      }),
    ).resolves.toEqual({ acquired: true, value: "done" });
  });

  it("reports a failed release instead of masking the callback's result", async () => {
    const lock = new MemoryDistributedLock();
    const acquire = lock.acquire.bind(lock);
    vi.spyOn(lock, "acquire").mockImplementation(async (key, opts) => {
      const held = await acquire(key, opts);
      return held === undefined
        ? undefined
        : {
            ...held,
            release: () => Promise.reject(new Error("store down")),
          };
    });
    const onReleaseError = vi.fn();

    await expect(withLock(lock, "k", () => "done", { onReleaseError })).resolves.toEqual({
      acquired: true,
      value: "done",
    });
    expect(onReleaseError).toHaveBeenCalledOnce();
  });
});
