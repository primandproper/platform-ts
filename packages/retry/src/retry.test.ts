import { describe, expect, it, vi } from "vitest";

import { exponentialBackoff } from "./retry.js";

import { providePolicy } from "./index.js";

const noJitter = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 30_000, jitter: 0 };

describe("exponentialBackoff", () => {
  it("returns the first success without sleeping", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const op = vi.fn<() => Promise<string>>().mockResolvedValue("ok");

    await expect(exponentialBackoff(noJitter, { sleep }).run(op)).resolves.toBe("ok");
    expect(op).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries up to maxAttempts then rethrows the last error", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const op = vi.fn<() => Promise<never>>().mockRejectedValue(new Error("boom"));

    await expect(exponentialBackoff(noJitter, { sleep }).run(op)).rejects.toThrow("boom");
    expect(op).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("doubles the delay between attempts", async () => {
    const delays: number[] = [];
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockImplementation((ms) => {
      delays.push(ms);
      return Promise.resolve();
    });
    let calls = 0;
    const op = vi.fn<() => Promise<number>>().mockImplementation(() => {
      calls += 1;
      return calls < 3 ? Promise.reject(new Error("x")) : Promise.resolve(calls);
    });

    await expect(
      exponentialBackoff({ ...noJitter, maxAttempts: 5 }, { sleep }).run(op),
    ).resolves.toBe(3);
    expect(delays).toStrictEqual([100, 200]);
  });
});

describe("providePolicy", () => {
  it("applies the default maxAttempts of 3", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const op = vi.fn<() => Promise<never>>().mockRejectedValue(new Error("nope"));

    await expect(providePolicy({ jitter: 0 }, { sleep }).run(op)).rejects.toThrow();
    expect(op).toHaveBeenCalledTimes(3);
  });
});
