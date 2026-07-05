import {
  type Logger,
  type MeterProvider,
  type ObservabilityDeps,
} from "@primandproper/observability";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { nodeClient, browserClient, PostHogNodeMock, PostHogJsMock } = vi.hoisted(() => {
  const nodeClient = {
    capture: vi.fn(),
    identify: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
    shutdown: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
  };
  const browserClient = {
    init: vi.fn(),
    capture: vi.fn(),
    identify: vi.fn(),
  };
  return {
    nodeClient,
    browserClient,
    PostHogNodeMock: vi.fn(() => nodeClient),
    PostHogJsMock: vi.fn(() => browserClient),
  };
});

vi.mock("posthog-node", () => ({ PostHog: PostHogNodeMock }));
vi.mock("posthog-js", () => ({ PostHog: PostHogJsMock }));

const { providePostHog: providePostHogNode } = await import("./posthog.node.js");
const { providePostHog: providePostHogBrowser } = await import("./posthog.browser.js");

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

describe("providePostHog (node)", () => {
  it("captures with a distinct id derived from context", () => {
    providePostHogNode({ apiKey: "k" }).track(
      "signed_up",
      { plan: "pro" },
      { userId: "u1" },
    );
    expect(nodeClient.capture).toHaveBeenCalledWith({
      distinctId: "u1",
      event: "signed_up",
      properties: { plan: "pro" },
    });
  });

  it("falls back to a synthetic distinct id when none is supplied", () => {
    providePostHogNode({ apiKey: "k" }).track("viewed");
    expect(nodeClient.capture).toHaveBeenCalledWith({
      distinctId: "anonymous",
      event: "viewed",
    });
  });

  it("maps page to a $pageview event", () => {
    providePostHogNode({ apiKey: "k" }).page?.("home", undefined, { userId: "u1" });
    expect(nodeClient.capture).toHaveBeenCalledWith({
      distinctId: "u1",
      event: "$pageview",
      properties: { $screen_name: "home" },
    });
  });

  it("flush and shutdown delegate to the SDK", async () => {
    const reporter = providePostHogNode({ apiKey: "k" });
    await reporter.flush();
    await reporter.shutdown();
    expect(nodeClient.flush).toHaveBeenCalledOnce();
    expect(nodeClient.shutdown).toHaveBeenCalledOnce();
  });

  it("passes the default host when none is configured", () => {
    providePostHogNode({ apiKey: "k" });
    expect(PostHogNodeMock).toHaveBeenCalledWith("k", {
      host: "https://us.i.posthog.com",
    });
  });

  it("surfaces a background delivery error from the client's error listener", () => {
    const { deps, adds, errors } = recordingDeps();
    providePostHogNode({ apiKey: "k" }, deps);

    const [event, handler] = nodeClient.on.mock.calls[0] ?? [];
    expect(event).toBe("error");
    expect(handler).toBeTypeOf("function");

    (handler as (err: unknown) => void)(new Error("delivery boom"));

    expect(adds).toContainEqual({
      name: "analytics.events.dropped",
      attributes: { provider: "posthog" },
    });
    expect(errors).toHaveLength(1);
  });
});

describe("providePostHog (browser)", () => {
  it("initializes the SDK and captures positionally", () => {
    const reporter = providePostHogBrowser({
      apiKey: "k",
      host: "https://eu.posthog.com",
    });
    reporter.track("clicked", { id: 1 });
    expect(browserClient.init).toHaveBeenCalledWith("k", {
      api_host: "https://eu.posthog.com",
    });
    expect(browserClient.capture).toHaveBeenCalledWith("clicked", { id: 1 });
  });

  it("flush and shutdown are no-ops that never throw", async () => {
    const reporter = providePostHogBrowser({ apiKey: "k" });
    await expect(reporter.flush()).resolves.toBeUndefined();
    await expect(reporter.shutdown()).resolves.toBeUndefined();
  });
});
