import { describe, expect, it } from "vitest";

import { InMemoryReporter } from "./memory.js";
import { MultiSourceReporter, SOURCE_PROPERTY_KEY } from "./multisource.js";

describe("MultiSourceReporter", () => {
  it("routes to the reporter for the given source and stamps the source property", () => {
    const ios = new InMemoryReporter();
    const web = new InMemoryReporter();
    const reporter = new MultiSourceReporter({ ios, web });

    reporter.track("ios", "opened", { screen: "home" });

    expect(ios.tracks).toStrictEqual([
      {
        event: "opened",
        properties: { screen: "home", [SOURCE_PROPERTY_KEY]: "ios" },
        context: undefined,
      },
    ]);
    expect(web.tracks).toEqual([]);
  });

  it("stamps the source into identify traits", () => {
    const ios = new InMemoryReporter();
    const reporter = new MultiSourceReporter({ ios });

    reporter.identify("ios", "u1", { plan: "pro" });

    expect(ios.identifies).toStrictEqual([
      { userId: "u1", traits: { plan: "pro", [SOURCE_PROPERTY_KEY]: "ios" } },
    ]);
  });

  it("falls back to a noop for an unknown source without throwing", () => {
    const reporter = new MultiSourceReporter({});
    expect(() => {
      reporter.track("unknown", "evt");
    }).not.toThrow();
  });

  it("fans flush and shutdown out to every source", async () => {
    const ios = new InMemoryReporter();
    const web = new InMemoryReporter();
    const reporter = new MultiSourceReporter({ ios, web });

    await reporter.flush();
    await reporter.shutdown();

    // one explicit flush plus the implicit flush inside shutdown
    expect(ios.flushes).toBe(2);
    expect(web.isShutdown).toBe(true);
  });
});
