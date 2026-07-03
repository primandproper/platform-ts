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
});
