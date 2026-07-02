import { describe, expect, it } from "vitest";

import { makeMetrics, provideMeterProvider } from "./metrics.js";
import { noopMeterProvider, type MeterProvider } from "./observability.js";

describe("provideMeterProvider", () => {
  it("falls back to the noop meter provider with no deps", () => {
    expect(provideMeterProvider()).toBe(noopMeterProvider);
  });

  it("falls back to the noop meter provider for the otel provider without injection", () => {
    expect(provideMeterProvider({ provider: "otel" })).toBe(noopMeterProvider);
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
