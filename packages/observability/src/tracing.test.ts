import { type Span, SpanStatusCode, type Tracer } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";

import {
  defaultTracerProvider,
  noopTracerProvider,
  type TracerProvider,
} from "./observability.js";
import { provideTracerProvider, withSpan } from "./tracing.js";

describe("provideTracerProvider", () => {
  it("defaults to the global-backed tracer provider with no deps", () => {
    expect(provideTracerProvider()).toBe(defaultTracerProvider);
  });

  it("uses the global-backed provider for otel without injection", () => {
    expect(provideTracerProvider({ provider: "otel" })).toBe(defaultTracerProvider);
  });

  it("forces the genuinely-inert provider for noop, even with an injected tracer", () => {
    const injected: TracerProvider = {
      getTracer: (name) => defaultTracerProvider.getTracer(name),
    };
    expect(provideTracerProvider({ provider: "noop" }, { tracer: injected })).toBe(
      noopTracerProvider,
    );
  });

  it("returns an injected tracer provider", () => {
    const injected: TracerProvider = {
      getTracer: (name) => noopTracerProvider.getTracer(name),
    };
    expect(provideTracerProvider({ provider: "otel" }, { tracer: injected })).toBe(
      injected,
    );
  });

  it("rejects an unknown provider", () => {
    expect(() => provideTracerProvider({ provider: "bogus" as never })).toThrow();
  });
});

/** A recording-span double plus a tracer whose `startActiveSpan` hands it to the callback. */
function recordingTracer(): {
  tracer: Tracer;
  span: Record<string, ReturnType<typeof vi.fn>>;
} {
  const span = {
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
  const tracer: Tracer = {
    startSpan: vi.fn(),
    startActiveSpan: (_name: string, ...rest: unknown[]): unknown => {
      const fn = rest[rest.length - 1] as (s: Span) => unknown;
      return fn(span);
    },
  };
  return { tracer, span };
}

describe("withSpan", () => {
  const noopTracer = provideTracerProvider().getTracer("test");

  it("runs the callback and resolves its value over the noop tracer", async () => {
    await expect(withSpan(noopTracer, "op", () => 42)).resolves.toBe(42);
  });

  it("awaits an async callback", async () => {
    await expect(withSpan(noopTracer, "op", async () => "done")).resolves.toBe("done");
  });

  it("ends the span on success without setting a status", async () => {
    const { tracer, span } = recordingTracer();
    await withSpan(tracer, "op", () => undefined);
    expect(span.end).toHaveBeenCalledOnce();
    expect(span.setStatus).not.toHaveBeenCalled();
  });

  it("records the exception, sets ERROR status, ends the span, and re-throws", async () => {
    const { tracer, span } = recordingTracer();
    const boom = new Error("boom");
    await expect(
      withSpan(tracer, "op", () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(span.recordException).toHaveBeenCalledWith(boom);
    expect(span.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: "boom",
    });
    expect(span.end).toHaveBeenCalledOnce();
  });
});
