import {
  type Logger,
  type MeterProvider,
  type ObservabilityDeps,
} from "@primandproper/observability";
import { describe, expect, it, vi } from "vitest";

import { VendorReporter, type VendorSink } from "./vendor.js";

function makeSink(overrides: Partial<VendorSink> = {}) {
  const spies = {
    track: vi.fn(),
    identify: vi.fn(),
    page: vi.fn(),
    screen: vi.fn(),
    flush: vi.fn(),
    shutdown: vi.fn(),
  };
  const sink: VendorSink = { ...spies, ...overrides };
  return { sink, spies };
}

/** A meter provider capturing every counter add, for asserting the sent/dropped instruments. */
function recordingMeter(): {
  provider: MeterProvider;
  adds: {
    name: string;
    value: number;
    attributes: Record<string, unknown> | undefined;
  }[];
} {
  const adds: {
    name: string;
    value: number;
    attributes: Record<string, unknown> | undefined;
  }[] = [];
  const meter = {
    createCounter: (name: string) => ({
      add: (value: number, attributes?: Record<string, unknown>) => {
        adds.push({ name, value, attributes });
      },
    }),
    createHistogram: () => ({ record: () => undefined }),
    createUpDownCounter: () => ({ add: () => undefined }),
    createGauge: () => ({ record: () => undefined }),
  };
  return { provider: { getMeter: () => meter } as unknown as MeterProvider, adds };
}

/** A logger recording every error line, for asserting a failure is surfaced. */
function recordingLogger(): {
  logger: Logger;
  errors: { message: string; err: unknown }[];
} {
  const errors: { message: string; err: unknown }[] = [];
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (message: string, err?: unknown) => {
      errors.push({ message, err });
    },
    with: () => logger,
    child: () => logger,
    withSpan: () => logger,
  } as unknown as Logger;
  return { logger, errors };
}

function recordingDeps(): {
  deps: ObservabilityDeps;
  adds: ReturnType<typeof recordingMeter>["adds"];
  errors: ReturnType<typeof recordingLogger>["errors"];
} {
  const { provider, adds } = recordingMeter();
  const { logger, errors } = recordingLogger();
  return { deps: { metrics: provider, logger }, adds, errors };
}

describe("VendorReporter", () => {
  it("delegates each call to the sink", () => {
    const { sink, spies } = makeSink();
    const reporter = new VendorReporter("test", sink);

    reporter.track("e", { a: 1 }, { userId: "u" });
    reporter.identify("u", { n: "x" });
    reporter.page("p");
    reporter.screen("s");

    expect(spies.track).toHaveBeenCalledWith("e", { a: 1 }, { userId: "u" });
    expect(spies.identify).toHaveBeenCalledWith("u", { n: "x" });
    expect(spies.page).toHaveBeenCalledWith("p", undefined, undefined);
    expect(spies.screen).toHaveBeenCalledWith("s", undefined, undefined);
  });

  it("counts a sent event on each successful enqueue", () => {
    const { sink } = makeSink();
    const { deps, adds } = recordingDeps();
    const reporter = new VendorReporter("test", sink, deps);

    reporter.track("e");

    expect(adds).toContainEqual({
      name: "analytics.events.sent",
      value: 1,
      attributes: { provider: "test" },
    });
  });

  it("counts a dropped event and logs when a sink enqueue throws", () => {
    const { sink } = makeSink({
      track: () => {
        throw new Error("boom");
      },
    });
    const { deps, adds, errors } = recordingDeps();
    const reporter = new VendorReporter("test", sink, deps);

    reporter.track("e");

    expect(adds).toContainEqual({
      name: "analytics.events.dropped",
      value: 1,
      attributes: { provider: "test" },
    });
    expect(errors).toHaveLength(1);
  });

  it("surfaces a background delivery failure as a dropped event and a log line", () => {
    const { sink } = makeSink();
    const { deps, adds, errors } = recordingDeps();
    const reporter = new VendorReporter("test", sink, deps);

    reporter.onBackgroundError(new Error("delivery boom"));

    expect(adds).toContainEqual({
      name: "analytics.events.dropped",
      value: 1,
      attributes: { provider: "test" },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.err).toBeInstanceOf(Error);
  });

  it("swallows synchronous sink errors so the calling path never throws", () => {
    const { sink } = makeSink({
      track: () => {
        throw new Error("boom");
      },
    });
    const reporter = new VendorReporter("test", sink);

    expect(() => {
      reporter.track("e");
    }).not.toThrow();
  });

  it("swallows async flush/shutdown rejections", async () => {
    const { sink } = makeSink({
      flush: () => Promise.reject(new Error("flush failed")),
      shutdown: () => Promise.reject(new Error("shutdown failed")),
    });
    const reporter = new VendorReporter("test", sink);

    await expect(reporter.flush()).resolves.toBeUndefined();
    await expect(reporter.shutdown()).resolves.toBeUndefined();
  });

  // LC-12: a wedged flush/shutdown must not stall process exit — it is abandoned after the deadline.
  it("abandons a wedged flush after its deadline", async () => {
    vi.useFakeTimers();
    try {
      const { sink } = makeSink({ flush: () => new Promise<void>(() => undefined) });
      const reporter = new VendorReporter("test", sink, {}, { flushTimeoutMs: 50 });

      const done = reporter.flush();
      await vi.advanceTimersByTimeAsync(50);
      await expect(done).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("abandons a wedged shutdown after its deadline", async () => {
    vi.useFakeTimers();
    try {
      const { sink } = makeSink({ shutdown: () => new Promise<void>(() => undefined) });
      const reporter = new VendorReporter("test", sink, {}, { shutdownTimeoutMs: 50 });

      const done = reporter.shutdown();
      await vi.advanceTimersByTimeAsync(50);
      await expect(done).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
