import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureLogger, noopLogger } from "./logger.js";
import { consoleLogger } from "./providers/console.browser.js";

describe("ensureLogger", () => {
  it("returns the noop logger when none is provided", () => {
    expect(ensureLogger()).toBe(noopLogger);
  });

  it("returns the given logger when one is provided", () => {
    const logger = consoleLogger({ level: "info", name: "test" });
    expect(ensureLogger(logger)).toBe(logger);
  });
});

describe("noopLogger", () => {
  it("never throws and chains to itself", () => {
    expect(() => {
      noopLogger.info("hi");
      noopLogger.error("boom", new Error("x"));
    }).not.toThrow();
    expect(noopLogger.with({ a: 1 })).toBe(noopLogger);
    expect(noopLogger.child("c")).toBe(noopLogger);
  });
});

describe("consoleLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits at or above the configured level and suppresses below it", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const logger = consoleLogger({ level: "info", name: "svc" });
    logger.debug("hidden");
    logger.info("shown");

    expect(debug).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledOnce();
  });

  it("carries accumulated bindings onto every line", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    consoleLogger({ level: "info", name: "svc" }).with({ userId: 7 }).info("event");

    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("event"),
      expect.objectContaining({ userId: 7 }),
    );
  });
});
