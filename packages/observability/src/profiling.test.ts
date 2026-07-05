import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { noopProfiler, NoopProfiler, type Profiler } from "./profiling.js";
import { BrowserProfiler } from "./providers/profiling.browser.js";
import { PyroscopeProfiler } from "./providers/profiling.node.js";

// The pyroscope scaffold warns to console on construction (OBS-5); keep that out of test output.
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Provider-agnostic conformance: every profiler must start and stop idempotently without
 * throwing, regardless of whether real profiling is wired in.
 */
function conformance(name: string, make: () => Profiler): void {
  describe(name, () => {
    it("starts and stops without throwing", async () => {
      const profiler = make();
      await expect(profiler.start()).resolves.toBeUndefined();
      await expect(profiler.stop()).resolves.toBeUndefined();
    });

    it("is idempotent across repeated start/stop", async () => {
      const profiler = make();
      await profiler.start();
      await expect(profiler.start()).resolves.toBeUndefined();
      await profiler.stop();
      await expect(profiler.stop()).resolves.toBeUndefined();
    });
  });
}

conformance("noopProfiler", () => noopProfiler);
conformance("NoopProfiler", () => new NoopProfiler());
conformance("BrowserProfiler", () => new BrowserProfiler());
conformance(
  "PyroscopeProfiler",
  () => new PyroscopeProfiler({ provider: "pyroscope", name: "test" }),
);

describe("PyroscopeProfiler", () => {
  it("warns to console on construction so the unimplemented provider is never silent", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    new PyroscopeProfiler({ provider: "pyroscope", name: "test" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("pyroscope"));
  });
});
