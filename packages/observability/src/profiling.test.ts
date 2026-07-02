import { describe, expect, it } from "vitest";

import { noopProfiler, NoopProfiler, type Profiler } from "./profiling.js";
import { BrowserProfiler } from "./providers/profiling.browser.js";
import { PyroscopeProfiler } from "./providers/profiling.node.js";

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
