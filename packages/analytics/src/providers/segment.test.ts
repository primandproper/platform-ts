import {
  type Logger,
  type MeterProvider,
  type ObservabilityDeps,
} from "@primandproper/observability";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { nodeClient, browserClient, AnalyticsMock, loadMock } = vi.hoisted(() => {
  const nodeClient = {
    track: vi.fn(),
    identify: vi.fn(),
    page: vi.fn(),
    screen: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
    closeAndFlush: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
  };
  const browserClient = {
    track: vi.fn(),
    identify: vi.fn(),
    page: vi.fn(),
    screen: vi.fn(),
  };
  return {
    nodeClient,
    browserClient,
    AnalyticsMock: vi.fn(() => nodeClient),
    loadMock: vi.fn(() => browserClient),
  };
});

vi.mock("@segment/analytics-node", () => ({ Analytics: AnalyticsMock }));
vi.mock("@segment/analytics-next", () => ({ AnalyticsBrowser: { load: loadMock } }));

const { provideSegment: provideSegmentNode } = await import("./segment.node.js");
const { provideSegment: provideSegmentBrowser } = await import("./segment.browser.js");

beforeEach(() => {
  vi.clearAllMocks();
});

/** Deps whose meter and logger record counter adds and error lines, for asserting drops. */
function recordingDeps(): {
  deps: ObservabilityDeps;
  adds: { name: string; attributes: Record<string, unknown> | undefined }[];
  errors: unknown[];
} {
  const adds: { name: string; attributes: Record<string, unknown> | undefined }[] = [];
  const errors: unknown[] = [];
  const meter = {
    createCounter: (name: string) => ({
      add: (_value: number, attributes?: Record<string, unknown>) => {
        adds.push({ name, attributes });
      },
    }),
    createHistogram: () => ({ record: () => undefined }),
    createUpDownCounter: () => ({ add: () => undefined }),
    createGauge: () => ({ record: () => undefined }),
  };
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (_message: string, err?: unknown) => {
      errors.push(err);
    },
    with: () => logger,
    child: () => logger,
    withSpan: () => logger,
  } as unknown as Logger;
  return {
    deps: { metrics: { getMeter: () => meter } as unknown as MeterProvider, logger },
    adds,
    errors,
  };
}

describe("provideSegment (node)", () => {
  it("maps track to the SDK with the identity taken from context", () => {
    provideSegmentNode({ writeKey: "wk" }).track(
      "signed_up",
      { plan: "pro" },
      { userId: "u1" },
    );
    expect(nodeClient.track).toHaveBeenCalledWith({
      event: "signed_up",
      properties: { plan: "pro" },
      userId: "u1",
    });
  });

  it("falls back to a synthetic anonymous id when the caller supplies none", () => {
    provideSegmentNode({ writeKey: "wk" }).track("viewed");
    expect(nodeClient.track).toHaveBeenCalledWith({
      event: "viewed",
      anonymousId: "anonymous",
    });
  });

  it("flush drains and shutdown closes, both delegating to the SDK", async () => {
    const reporter = provideSegmentNode({ writeKey: "wk" });
    await expect(reporter.flush()).resolves.toBeUndefined();
    await expect(reporter.shutdown()).resolves.toBeUndefined();
    expect(nodeClient.flush).toHaveBeenCalledOnce();
    expect(nodeClient.closeAndFlush).toHaveBeenCalledOnce();
  });

  it("swallows SDK errors so the calling path never throws", () => {
    nodeClient.track.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    expect(() => {
      provideSegmentNode({ writeKey: "wk" }).track("x");
    }).not.toThrow();
  });

  it("surfaces a background delivery error from the client's error listener", () => {
    const { deps, adds, errors } = recordingDeps();
    provideSegmentNode({ writeKey: "wk" }, deps);

    const [event, handler] = nodeClient.on.mock.calls[0] ?? [];
    expect(event).toBe("error");
    expect(handler).toBeTypeOf("function");

    (handler as (err: unknown) => void)(new Error("delivery boom"));

    expect(adds).toContainEqual({
      name: "analytics.events.dropped",
      attributes: { provider: "segment" },
    });
    expect(errors).toHaveLength(1);
  });
});

describe("provideSegment (browser)", () => {
  it("maps track positionally onto the browser SDK", () => {
    provideSegmentBrowser({ writeKey: "wk" }).track("clicked", { id: 1 });
    expect(browserClient.track).toHaveBeenCalledWith("clicked", { id: 1 });
  });

  it("flush and shutdown are no-ops that never throw", async () => {
    const reporter = provideSegmentBrowser({ writeKey: "wk" });
    await expect(reporter.flush()).resolves.toBeUndefined();
    await expect(reporter.shutdown()).resolves.toBeUndefined();
  });
});
