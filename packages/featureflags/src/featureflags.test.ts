import type { Logger, LogValues } from "@primandproper/observability";
import { describe, expect, it, vi } from "vitest";

import type { FeatureFlagManager } from "./featureflags.js";
import { NoopFeatureFlagManager } from "./providers/noop.js";
import { StaticFeatureFlagManager } from "./providers/static.js";

/** A Logger that records each debug line's message and values; chainable methods return itself. */
function recordingLogger(): {
  logger: Logger;
  debugs: { message: string; values: LogValues | undefined }[];
} {
  const debugs: { message: string; values: LogValues | undefined }[] = [];
  const logger: Logger = {
    debug: (message, values) => {
      debugs.push({ message, values });
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    with: () => logger,
    child: () => logger,
    withSpan: () => logger,
  };
  return { logger, debugs };
}

/**
 * Provider-agnostic conformance suite. Running the same assertions against multiple
 * providers proves the `FeatureFlagManager` interface is implementation-independent.
 *
 * `evaluates` flags whether the provider serves configured values (`static`) or always
 * falls back to the caller's default (`noop`).
 */
function conformance(
  name: string,
  make: () => FeatureFlagManager,
  opts: { readonly evaluates: boolean },
): void {
  describe(name, () => {
    it("returns the default for an unknown flag", async () => {
      const ff = make();
      expect(await ff.boolVariation("missing", true)).toBe(true);
      expect(await ff.stringVariation("missing", "fallback")).toBe("fallback");
      expect(await ff.numberVariation("missing", 7)).toBe(7);
    });

    it("evaluates a known boolean flag", async () => {
      expect(await make().boolVariation("bool-flag", false)).toBe(
        opts.evaluates ? true : false,
      );
    });

    it("evaluates a known string flag", async () => {
      expect(await make().stringVariation("string-flag", "default")).toBe(
        opts.evaluates ? "blue" : "default",
      );
    });

    it("evaluates a known number flag", async () => {
      expect(await make().numberVariation("number-flag", 0)).toBe(
        opts.evaluates ? 42 : 0,
      );
    });

    it("evaluates a known json flag", async () => {
      const result = await make().jsonVariation<{ ratio: number }>("json-flag", {
        ratio: 0,
      });
      expect(result).toStrictEqual(opts.evaluates ? { ratio: 0.5 } : { ratio: 0 });
    });

    it("falls back to the default on a type mismatch", async () => {
      // bool-flag holds a boolean; requesting it as a string must yield the default.
      expect(await make().stringVariation("bool-flag", "default")).toBe("default");
    });

    it("evaluates via the generic primitive", async () => {
      expect(await make().evaluate("number-flag", 0)).toBe(opts.evaluates ? 42 : 0);
    });
  });
}

const flags = {
  "bool-flag": true,
  "string-flag": "blue",
  "number-flag": 42,
  "json-flag": { ratio: 0.5 },
};

conformance("StaticFeatureFlagManager", () => new StaticFeatureFlagManager({ flags }), {
  evaluates: true,
});
conformance("NoopFeatureFlagManager", () => new NoopFeatureFlagManager(), {
  evaluates: false,
});

describe("StaticFeatureFlagManager targeting", () => {
  const make = (): StaticFeatureFlagManager =>
    new StaticFeatureFlagManager({
      flags: {
        "new-checkout": {
          value: false,
          rules: [
            { when: { plan: "enterprise" }, value: true },
            { when: { beta: true }, value: true },
          ],
        },
      },
    });

  it("returns the base value when no rule matches", async () => {
    expect(await make().boolVariation("new-checkout", false)).toBe(false);
    expect(
      await make().boolVariation("new-checkout", false, {
        key: "u-1",
        attributes: { plan: "free" },
      }),
    ).toBe(false);
  });

  it("applies the first matching targeting rule", async () => {
    expect(
      await make().boolVariation("new-checkout", false, {
        key: "u-2",
        attributes: { plan: "enterprise" },
      }),
    ).toBe(true);
    expect(
      await make().boolVariation("new-checkout", false, {
        key: "u-3",
        attributes: { beta: true },
      }),
    ).toBe(true);
  });
});

describe("StaticFeatureFlagManager allFlags", () => {
  it("returns every flag resolved for the context", async () => {
    const ff = new StaticFeatureFlagManager({
      flags: {
        a: 1,
        b: { value: "off", rules: [{ when: { region: "eu" }, value: "on" }] },
      },
    });
    expect(await ff.allFlags({ attributes: { region: "eu" } })).toStrictEqual({
      a: 1,
      b: "on",
    });
  });
});

describe("StaticFeatureFlagManager logging", () => {
  it("names the flag key when a flag is not found", async () => {
    const { logger, debugs } = recordingLogger();
    const ff = new StaticFeatureFlagManager({ flags: { known: true } }, { logger });

    expect(await ff.evaluate("missing", false)).toBe(false);

    const line = debugs.find((d) => d.message === "feature flag not found");
    expect(line?.values).toMatchObject({ key: "missing" });
  });
});

describe("StaticFeatureFlagManager type safety", () => {
  it("returns the default and warns when the stored value's type differs from the requested type", async () => {
    const warns: { message: string; values: LogValues | undefined }[] = [];
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: (message, values) => {
        warns.push({ message, values });
      },
      error: vi.fn(),
      with: () => logger,
      child: () => logger,
      withSpan: () => logger,
    };
    // Flag stored as a string, evaluated with a boolean default.
    const ff = new StaticFeatureFlagManager({ flags: { feature: "on" } }, { logger });

    const value = await ff.evaluate("feature", false);
    expect(value).toBe(false);
    const line = warns.find((w) => w.message.includes("type mismatch"));
    expect(line?.values).toMatchObject({
      key: "feature",
      expected: "boolean",
      actual: "string",
    });
  });

  it("still returns a matching-typed flag value", async () => {
    const ff = new StaticFeatureFlagManager({ flags: { feature: "on" } });
    expect(await ff.evaluate("feature", "off")).toBe("on");
  });
});

describe("NoopFeatureFlagManager", () => {
  it("returns an empty allFlags map", async () => {
    expect(await new NoopFeatureFlagManager().allFlags()).toStrictEqual({});
  });
});
