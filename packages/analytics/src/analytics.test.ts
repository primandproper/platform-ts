import { describe, expect, it } from "vitest";

import type { EventReporter } from "./analytics.js";
import { ConsoleReporter } from "./providers/console.js";
import { InMemoryReporter } from "./providers/memory.js";
import { NoopReporter } from "./providers/noop.js";

/**
 * Provider-agnostic conformance suite. Running the same assertions against every provider
 * proves the `EventReporter` interface is implementation-independent — and, crucially, that
 * no provider throws on the reporting path.
 */
function conformance(name: string, make: () => EventReporter): void {
  describe(name, () => {
    it("tracks without throwing", () => {
      expect(() => {
        make().track("signed_up", { plan: "pro" });
      }).not.toThrow();
    });

    it("identifies without throwing", () => {
      expect(() => {
        make().identify("user-1", { email: "a@b.test" });
      }).not.toThrow();
    });

    it("records page and screen without throwing", () => {
      const reporter = make();
      expect(() => reporter.page?.("home")).not.toThrow();
      expect(() => reporter.screen?.("dashboard")).not.toThrow();
    });

    it("flushes without throwing", async () => {
      await expect(make().flush()).resolves.toBeUndefined();
    });

    it("shuts down without throwing", async () => {
      await expect(make().shutdown()).resolves.toBeUndefined();
    });
  });
}

conformance("NoopReporter", () => new NoopReporter());
conformance("InMemoryReporter", () => new InMemoryReporter());
conformance("ConsoleReporter", () => new ConsoleReporter());

describe("InMemoryReporter capture", () => {
  it("captures track calls with properties and context", () => {
    const reporter = new InMemoryReporter();
    reporter.track("purchased", { amount: 9.99 }, { userId: "u-1" });
    expect(reporter.tracks).toStrictEqual([
      {
        event: "purchased",
        properties: { amount: 9.99 },
        context: { userId: "u-1" },
      },
    ]);
  });

  it("captures identify calls with traits", () => {
    const reporter = new InMemoryReporter();
    reporter.identify("u-2", { name: "Ada" });
    expect(reporter.identifies).toStrictEqual([
      { userId: "u-2", traits: { name: "Ada" } },
    ]);
  });

  it("captures page and screen calls", () => {
    const reporter = new InMemoryReporter();
    reporter.page("landing", { ref: "ad" });
    reporter.screen("settings");
    expect(reporter.pages).toStrictEqual([
      { name: "landing", properties: { ref: "ad" }, context: undefined },
    ]);
    expect(reporter.screens).toStrictEqual([
      { name: "settings", properties: undefined, context: undefined },
    ]);
  });

  it("counts flushes and records shutdown", async () => {
    const reporter = new InMemoryReporter();
    await reporter.flush();
    await reporter.shutdown();
    expect(reporter.flushes).toBe(2);
    expect(reporter.isShutdown).toBe(true);
  });
});
