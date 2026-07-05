import { describe, expect, it, vi } from "vitest";

import { exponentialBackoff, type RetryLogger, type RetryLogValues } from "./retry.js";

import { providePolicy } from "./index.js";

const noJitter = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 30_000,
  jitter: 0,
  maxElapsedMs: 0,
};

/** A RetryLogger that records the message + values passed to each level. */
function recordingLogger(): {
  logger: RetryLogger;
  debugs: { message: string; values: RetryLogValues | undefined }[];
  warns: { message: string; values: RetryLogValues | undefined }[];
} {
  const debugs: { message: string; values: RetryLogValues | undefined }[] = [];
  const warns: { message: string; values: RetryLogValues | undefined }[] = [];
  const logger: RetryLogger = {
    debug: (message, values) => {
      debugs.push({ message, values });
    },
    warn: (message, values) => {
      warns.push({ message, values });
    },
  };
  return { logger, debugs, warns };
}

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

  it("logs the causing error per attempt and a warn on exhaustion", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const boom = new Error("boom");
    const op = vi.fn<() => Promise<never>>().mockRejectedValue(boom);
    const { logger, debugs, warns } = recordingLogger();

    await expect(exponentialBackoff(noJitter, { sleep, logger }).run(op)).rejects.toThrow(
      "boom",
    );

    // Two retry attempts, each carrying the causing error.
    expect(debugs).toHaveLength(2);
    expect(debugs[0]?.values).toMatchObject({ attempt: 1, error: boom });

    // Exhaustion surfaces once at warn with the attempt count and the final error.
    expect(warns).toHaveLength(1);
    expect(warns[0]?.message).toContain("exhausted");
    expect(warns[0]?.values).toMatchObject({ attempts: 3, error: boom });
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

  it("does not retry an error the predicate rejects", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const op = vi.fn<() => Promise<never>>().mockRejectedValue(new Error("client 400"));
    const shouldRetry = vi
      .fn<(e: unknown, a: number) => boolean>()
      .mockReturnValue(false);

    await expect(
      exponentialBackoff(noJitter, { sleep, shouldRetry }).run(op),
    ).rejects.toThrow("client 400");
    // Surfaced on the first failure — no second attempt, no sleep.
    expect(op).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect(shouldRetry).toHaveBeenCalledWith(expect.any(Error), 1);
  });

  it("gives up once the elapsed budget would be exceeded", async () => {
    // now() advances 1s per read; a 100ms budget is blown before the first backoff.
    let clock = 0;
    const now = vi.fn<() => number>().mockImplementation(() => (clock += 1000));
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const op = vi.fn<() => Promise<never>>().mockRejectedValue(new Error("slow"));
    const { logger, warns } = recordingLogger();

    await expect(
      exponentialBackoff(
        { ...noJitter, maxAttempts: 10, maxElapsedMs: 100 },
        { sleep, now, logger },
      ).run(op),
    ).rejects.toThrow("slow");
    expect(sleep).not.toHaveBeenCalled();
    expect(warns).toHaveLength(1);
    expect(warns[0]?.message).toContain("deadline");
  });

  it("aborts the backoff sleep when the signal fires", async () => {
    const controller = new AbortController();
    // A sleep that never resolves on its own — only the abort can end it.
    const sleep = vi
      .fn<(ms: number) => Promise<void>>()
      .mockImplementation(() => new Promise<void>(() => undefined));
    const op = vi.fn<() => Promise<never>>().mockRejectedValue(new Error("boom"));

    const run = exponentialBackoff(noJitter, { sleep })
      .run(op, { signal: controller.signal })
      .catch((e: unknown) => e);
    await Promise.resolve();
    controller.abort(new Error("cancelled"));

    await expect(run).resolves.toStrictEqual(new Error("cancelled"));
    expect(op).toHaveBeenCalledOnce();
  });

  it("does not start the operation when the signal is already aborted", async () => {
    const op = vi.fn<() => Promise<string>>().mockResolvedValue("ok");
    await expect(
      exponentialBackoff(noJitter, {}).run(op, {
        signal: AbortSignal.abort(new Error("nope")),
      }),
    ).rejects.toThrow("nope");
    expect(op).not.toHaveBeenCalled();
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
