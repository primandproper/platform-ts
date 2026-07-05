import type { Logger, LogValues } from "@primandproper/observability";
import { describe, expect, it } from "vitest";

import { InMemoryReporter } from "./memory.js";
import { MultiSourceReporter, SOURCE_PROPERTY_KEY } from "./multisource.js";

/** A logger that counts warn lines, returning itself for `with`/`child`/`withSpan`. */
function countingLogger(): {
  logger: Logger;
  warns: { message: string; values: LogValues }[];
} {
  const warns: { message: string; values: LogValues }[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message, values) => void warns.push({ message, values: values ?? {} }),
    error: () => undefined,
    with: () => logger,
    child: () => logger,
    withSpan: () => logger,
  };
  return { logger, warns };
}

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

  it("warns only once per unknown source, not on every call (AN-2)", () => {
    const { logger, warns } = countingLogger();
    const reporter = new MultiSourceReporter({}, { logger });

    reporter.track("unknown", "a");
    reporter.track("unknown", "b");
    reporter.track("other", "c");

    // one warn for "unknown" (deduped across two calls) plus one for "other".
    expect(warns).toHaveLength(2);
    expect(warns[0]?.values).toMatchObject({ source: "unknown" });
    expect(warns[1]?.values).toMatchObject({ source: "other" });
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
