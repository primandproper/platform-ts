import { type Meter, type Span, type Tracer } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";

import { type Logger } from "./logger.js";
import { type MeterProvider, type TracerProvider } from "./observability.js";
import { makeObserver } from "./observer.js";

/** A meter provider capturing every instrument record/add, for asserting auto-recorded metrics. */
function recordingMeter(): {
  provider: MeterProvider;
  records: {
    name: string;
    value: number;
    attributes: Record<string, unknown> | undefined;
  }[];
  adds: {
    name: string;
    value: number;
    attributes: Record<string, unknown> | undefined;
  }[];
} {
  const records: {
    name: string;
    value: number;
    attributes: Record<string, unknown> | undefined;
  }[] = [];
  const adds: {
    name: string;
    value: number;
    attributes: Record<string, unknown> | undefined;
  }[] = [];
  const meter = {
    createHistogram: (name: string) => ({
      record: (value: number, attributes?: Record<string, unknown>) => {
        records.push({ name, value, attributes });
      },
    }),
    createCounter: (name: string) => ({
      add: (value: number, attributes?: Record<string, unknown>) => {
        adds.push({ name, value, attributes });
      },
    }),
    createUpDownCounter: () => ({ add: () => undefined }),
    createGauge: () => ({ record: () => undefined }),
  } as unknown as Meter;
  return { provider: { getMeter: () => meter }, records, adds };
}

/** A recording span plus a tracer wiring it into both `startSpan` and `startActiveSpan`. */
function recordingTracer(): {
  provider: TracerProvider;
  startSpan: ReturnType<typeof vi.fn>;
  span: Record<string, ReturnType<typeof vi.fn>>;
  names: string[];
} {
  const names: string[] = [];
  const spanMocks = {
    spanContext: vi.fn(),
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
    addEvent: vi.fn(),
    addLink: vi.fn(),
    addLinks: vi.fn(),
    setStatus: vi.fn(),
    updateName: vi.fn(),
    end: vi.fn(),
    isRecording: vi.fn(() => true),
    recordException: vi.fn(),
  };
  const span = spanMocks as unknown as Span;
  const startSpan = vi.fn((name: string) => {
    names.push(name);
    return span;
  });
  const startActiveSpan = ((name: string, ...rest: unknown[]): unknown => {
    names.push(name);
    const fn = rest[rest.length - 1] as (s: Span) => unknown;
    return fn(span);
  }) as Tracer["startActiveSpan"];
  const tracer = { startSpan, startActiveSpan } as unknown as Tracer;
  const provider: TracerProvider = { getTracer: () => tracer };
  return { provider, startSpan, span: spanMocks, names };
}

/**
 * A logger recording the names it was `child`-ed under and every `error` call across all its
 * derived children (via a shared sink, since `with`/`withSpan`/`child` return fresh loggers).
 */
function recordingLogger(): {
  logger: Logger;
  childNames: string[];
  errorCalls: { message: string; err: unknown }[];
} {
  const childNames: string[] = [];
  const errorCalls: { message: string; err: unknown }[] = [];
  const make = (): Logger => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: (message, err) => {
      errorCalls.push({ message, err });
    },
    with: () => make(),
    child: (name) => {
      childNames.push(name);
      return make();
    },
    withSpan: () => make(),
  });
  return { logger: make(), childNames, errorCalls };
}

describe("makeObserver", () => {
  it("names the logger and tracer after the component", () => {
    const { logger, childNames } = recordingLogger();
    const inner = recordingTracer();
    const getTracer = vi.fn(() => inner.provider.getTracer("inner"));

    makeObserver("cache", { logger, tracer: { getTracer } });

    expect(childNames).toContain("cache");
    expect(getTracer).toHaveBeenCalledWith("cache");
  });

  it("falls back to the noop logger and tracer with no deps", () => {
    const observer = makeObserver("standalone");
    // Smoke: nothing throws and an operation can be opened and ended.
    expect(() => {
      observer.begin("op").end();
    }).not.toThrow();
  });

  describe("begin", () => {
    it("starts a named span and returns an operation linked to it", () => {
      const { logger } = recordingLogger();
      const { provider, span, names } = recordingTracer();

      const op = makeObserver("svc", { logger, tracer: provider }).begin("doWork");
      op.set("k", "v");

      expect(names).toEqual(["doWork"]);
      expect(span.setAttribute).toHaveBeenCalledWith("k", "v");
    });

    it("passes span options through", () => {
      const { logger } = recordingLogger();
      const { provider, startSpan } = recordingTracer();

      makeObserver("svc", { logger, tracer: provider }).begin("doWork", {
        attributes: { root: true },
      });

      expect(startSpan).toHaveBeenCalledWith("doWork", { attributes: { root: true } });
    });
  });

  describe("run", () => {
    it("runs the callback inside an active span and resolves its value", async () => {
      const { logger } = recordingLogger();
      const { provider, span, names } = recordingTracer();

      const observer = makeObserver("svc", { logger, tracer: provider });
      const result = await observer.run("doWork", (op) => {
        op.set("k", "v");
        return 42;
      });

      expect(result).toBe(42);
      expect(names).toEqual(["doWork"]);
      expect(span.setAttribute).toHaveBeenCalledWith("k", "v");
      expect(span.end).toHaveBeenCalledOnce();
    });

    it("ends the span and re-throws when the callback throws", async () => {
      const { logger } = recordingLogger();
      const { provider, span } = recordingTracer();
      const boom = new Error("boom");

      const observer = makeObserver("svc", { logger, tracer: provider });
      await expect(
        observer.run("doWork", () => {
          throw boom;
        }),
      ).rejects.toBe(boom);

      expect(span.recordException).toHaveBeenCalledWith(boom);
      expect(span.end).toHaveBeenCalledOnce();
    });

    // OBS-1: a component that only calls run gets duration + outcome metrics for free.
    it("auto-records a duration histogram and outcome counter on success", async () => {
      const { logger } = recordingLogger();
      const { provider } = recordingTracer();
      const meter = recordingMeter();

      const observer = makeObserver("svc", {
        logger,
        tracer: provider,
        metrics: meter.provider,
      });
      await observer.run("doWork", () => 1);

      expect(meter.records).toContainEqual(
        expect.objectContaining({
          name: "operation.duration",
          attributes: { operation: "doWork", outcome: "ok" },
        }),
      );
      expect(meter.adds).toContainEqual({
        name: "operation.count",
        value: 1,
        attributes: { operation: "doWork", outcome: "ok" },
      });
    });

    it("tags the auto-recorded metrics with the error outcome when the callback throws", async () => {
      const { logger } = recordingLogger();
      const { provider } = recordingTracer();
      const meter = recordingMeter();

      const observer = makeObserver("svc", {
        logger,
        tracer: provider,
        metrics: meter.provider,
      });
      await expect(
        observer.run("doWork", () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(meter.adds).toContainEqual({
        name: "operation.count",
        value: 1,
        attributes: { operation: "doWork", outcome: "error" },
      });
      expect(meter.records).toContainEqual(
        expect.objectContaining({
          name: "operation.duration",
          attributes: { operation: "doWork", outcome: "error" },
        }),
      );
    });

    // OBS-2: an uncaught throw is logged exactly once and recorded on the span exactly once.
    it("logs and records an uncaught throw exactly once", async () => {
      const { logger, errorCalls } = recordingLogger();
      const { provider, span } = recordingTracer();
      const boom = new Error("boom");

      const observer = makeObserver("svc", { logger, tracer: provider });
      await expect(
        observer.run("doWork", () => {
          throw boom;
        }),
      ).rejects.toBe(boom);

      expect(span.recordException).toHaveBeenCalledOnce();
      expect(errorCalls).toHaveLength(1);
      expect(errorCalls[0]?.err).toBe(boom);
    });

    // OBS-3: routing the throw through op.error must not double-record or double-log.
    it("does not double-record when the callback throws op.error", async () => {
      const { logger, errorCalls } = recordingLogger();
      const { provider, span } = recordingTracer();
      const boom = new Error("boom");

      const observer = makeObserver("svc", { logger, tracer: provider });
      await expect(
        observer.run("doWork", (op) => {
          throw op.error(boom, "handling failed");
        }),
      ).rejects.toBe(boom);

      expect(span.recordException).toHaveBeenCalledOnce();
      expect(errorCalls).toHaveLength(1);
      expect(errorCalls[0]).toEqual({ message: "handling failed", err: boom });
    });
  });
});
