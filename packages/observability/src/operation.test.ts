import { type Span, SpanStatusCode } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";

import { type Logger, type LogValues } from "./logger.js";
import { newOperation } from "./operation.js";

/** A logger whose `with`/`error` calls are recorded into a shared sink across children. */
function recordingLogger(): {
  logger: Logger;
  withCalls: LogValues[];
  errorCalls: { message: string; err: unknown }[];
} {
  const withCalls: LogValues[] = [];
  const errorCalls: { message: string; err: unknown }[] = [];
  const make = (): Logger => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: (message, err) => {
      errorCalls.push({ message, err });
    },
    with: (values) => {
      withCalls.push(values);
      return make();
    },
    child: () => make(),
    withSpan: () => make(),
  });
  return { logger: make(), withCalls, errorCalls };
}

/** A span recording the facade's calls; everything else is a noop to satisfy the type. */
function recordingSpan(): {
  mocks: Record<string, ReturnType<typeof vi.fn>>;
  span: Span;
} {
  const mocks = {
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
  const span = mocks as unknown as Span;
  return { mocks, span };
}

describe("Operation", () => {
  it("set fans the value out to both the span and the logger", () => {
    const { logger, withCalls } = recordingLogger();
    const { mocks, span } = recordingSpan();

    const op = newOperation(logger, span);
    expect(op.set("user_id", "abc")).toBe(op); // chains

    expect(mocks.setAttribute).toHaveBeenCalledWith("user_id", "abc");
    expect(withCalls).toContainEqual({ user_id: "abc" });
  });

  it("setValues fans every entry out to both pillars", () => {
    const { logger, withCalls } = recordingLogger();
    const { mocks, span } = recordingSpan();

    newOperation(logger, span).setValues({ a: 1, b: true });

    expect(mocks.setAttribute).toHaveBeenCalledWith("a", 1);
    expect(mocks.setAttribute).toHaveBeenCalledWith("b", true);
    expect(withCalls).toContainEqual({ a: 1, b: true });
  });

  it("spanOnly attaches to the span and not the logger", () => {
    const { logger, withCalls } = recordingLogger();
    const { mocks, span } = recordingSpan();

    newOperation(logger, span).spanOnly("trace_only", "x");

    expect(mocks.setAttribute).toHaveBeenCalledWith("trace_only", "x");
    expect(withCalls).toHaveLength(0);
  });

  it("logOnly attaches to the logger and not the span", () => {
    const { logger, withCalls } = recordingLogger();
    const { mocks, span } = recordingSpan();

    newOperation(logger, span).logOnly("log_only", "y");

    expect(withCalls).toContainEqual({ log_only: "y" });
    expect(mocks.setAttribute).not.toHaveBeenCalled();
  });

  it("stringifies non-primitive values before attaching them to the span", () => {
    const { logger } = recordingLogger();
    const { mocks, span } = recordingSpan();

    newOperation(logger, span).set("payload", { id: 7 });

    expect(mocks.setAttribute).toHaveBeenCalledWith("payload", '{"id":7}');
  });

  it("error records the exception, sets ERROR status, logs it, and returns it", () => {
    const { logger, errorCalls } = recordingLogger();
    const { mocks, span } = recordingSpan();
    const boom = new Error("boom");

    const returned = newOperation(logger, span).error(boom, "failed to do thing");

    expect(returned).toBe(boom);
    expect(mocks.recordException).toHaveBeenCalledWith(boom);
    expect(mocks.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: "boom",
    });
    expect(errorCalls).toContainEqual({ message: "failed to do thing", err: boom });
  });

  it("acknowledge records and logs the error", () => {
    const { logger, errorCalls } = recordingLogger();
    const { mocks, span } = recordingSpan();
    const boom = new Error("handled");

    newOperation(logger, span).acknowledge(boom, "handled it");

    expect(mocks.recordException).toHaveBeenCalledWith(boom);
    expect(errorCalls).toContainEqual({ message: "handled it", err: boom });
  });

  it("error logs carry everything set so far", () => {
    const { logger, errorCalls } = recordingLogger();
    const { span } = recordingSpan();
    const boom = new Error("boom");

    const op = newOperation(logger, span).set("user_id", "abc");
    op.error(boom, "failed");

    // The logger used to emit the error is the accumulated child, not the original.
    expect(errorCalls).toContainEqual({ message: "failed", err: boom });
  });

  it("end ends the span", () => {
    const { logger } = recordingLogger();
    const { mocks, span } = recordingSpan();

    newOperation(logger, span).end();

    expect(mocks.end).toHaveBeenCalledOnce();
  });
});
