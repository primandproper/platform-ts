import { describe, expect, it } from "vitest";

import { makeMetrics, provideMeterProvider } from "./metrics.js";
import {
  defaultMeterProvider,
  noopMeterProvider,
  type MeterProvider,
} from "./observability.js";

describe("provideMeterProvider", () => {
  it("defaults to the global-backed meter provider with no deps", () => {
    expect(provideMeterProvider()).toBe(defaultMeterProvider);
  });

  it("uses the global-backed provider for otel without injection", () => {
    expect(provideMeterProvider({ provider: "otel" })).toBe(defaultMeterProvider);
  });

  it("forces the genuinely-inert provider for noop, even with an injected meter", () => {
    const injected: MeterProvider = {
      getMeter: (name) => defaultMeterProvider.getMeter(name),
    };
    expect(provideMeterProvider({ provider: "noop" }, { metrics: injected })).toBe(
      noopMeterProvider,
    );
  });

  it("returns an injected meter provider", () => {
    const injected: MeterProvider = {
      getMeter: (name) => noopMeterProvider.getMeter(name),
    };
    expect(provideMeterProvider({ provider: "otel" }, { metrics: injected })).toBe(
      injected,
    );
  });

  it("rejects an unknown provider", () => {
    expect(() => provideMeterProvider({ provider: "bogus" as never })).toThrow();
  });
});

describe("makeMetrics over the noop meter", () => {
  const metrics = makeMetrics("test", provideMeterProvider());

  it("mints and records every instrument without throwing", () => {
    expect(() => {
      metrics.counter("requests").add(1, { route: "/" });
      metrics.upDownCounter("inflight").add(-1);
      metrics.histogram("latency_ms").record(12.5);
      metrics.gauge("queue_depth").record(3);
    }).not.toThrow();
  });

  it("defaults to the noop provider when none is passed", () => {
    expect(() => {
      makeMetrics("test").counter("c").add(1);
    }).not.toThrow();
  });
});
