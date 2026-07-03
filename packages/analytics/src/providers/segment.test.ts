import { beforeEach, describe, expect, it, vi } from "vitest";

const { nodeClient, browserClient, AnalyticsMock, loadMock } = vi.hoisted(() => {
  const nodeClient = {
    track: vi.fn(),
    identify: vi.fn(),
    page: vi.fn(),
    screen: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
    closeAndFlush: vi.fn(() => Promise.resolve()),
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

describe("provideSegment (node)", () => {
  it("maps track to the SDK with the identity taken from context", () => {
    provideSegmentNode({ writeKey: "wk" }).track("signed_up", { plan: "pro" }, { userId: "u1" });
    expect(nodeClient.track).toHaveBeenCalledWith({
      event: "signed_up",
      properties: { plan: "pro" },
      userId: "u1",
    });
  });

  it("falls back to a synthetic anonymous id when the caller supplies none", () => {
    provideSegmentNode({ writeKey: "wk" }).track("viewed");
    expect(nodeClient.track).toHaveBeenCalledWith({ event: "viewed", anonymousId: "anonymous" });
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
