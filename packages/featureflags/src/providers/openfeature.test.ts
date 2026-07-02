import type { Client } from "@openfeature/server-sdk";
import { describe, expect, it } from "vitest";

import type { EvaluationContext, FlagValue } from "../featureflags.js";

import { OpenFeatureFeatureFlagManager, toOpenFeatureContext } from "./openfeature.js";

/**
 * A minimal fake OpenFeature client backed by a flag table. Like a real provider, it returns
 * the caller's default when a flag is absent or holds a value of a different runtime type, so
 * the adapter's type-routing and fallback behavior can be exercised without a network SDK.
 */
function fakeClient(
  flags: Record<string, FlagValue>,
  byTargetingKey?: Record<string, Record<string, FlagValue>>,
): Client {
  const pick = <T>(key: string, def: T, type: string, ctxKey?: string): T => {
    const table = ctxKey !== undefined ? (byTargetingKey?.[ctxKey] ?? flags) : flags;
    const value = table[key];
    return typeof value === type ? (value as T) : def;
  };
  return {
    getBooleanValue: (k: string, d: boolean, c?: { targetingKey?: string }) =>
      Promise.resolve(pick(k, d, "boolean", c?.targetingKey)),
    getStringValue: (k: string, d: string, c?: { targetingKey?: string }) =>
      Promise.resolve(pick(k, d, "string", c?.targetingKey)),
    getNumberValue: (k: string, d: number, c?: { targetingKey?: string }) =>
      Promise.resolve(pick(k, d, "number", c?.targetingKey)),
    getObjectValue: (k: string, d: unknown, c?: { targetingKey?: string }) =>
      Promise.resolve(pick(k, d, "object", c?.targetingKey)),
  } as unknown as Client;
}

const flags = {
  "bool-flag": true,
  "string-flag": "blue",
  "number-flag": 42,
  "json-flag": { ratio: 0.5 },
};

describe("OpenFeatureFeatureFlagManager", () => {
  const make = (): OpenFeatureFeatureFlagManager =>
    new OpenFeatureFeatureFlagManager(fakeClient(flags));

  it("returns the default for an unknown flag", async () => {
    const ff = make();
    expect(await ff.boolVariation("missing", true)).toBe(true);
    expect(await ff.stringVariation("missing", "fallback")).toBe("fallback");
    expect(await ff.numberVariation("missing", 7)).toBe(7);
  });

  it("routes each typed variation to the matching client getter", async () => {
    const ff = make();
    expect(await ff.boolVariation("bool-flag", false)).toBe(true);
    expect(await ff.stringVariation("string-flag", "default")).toBe("blue");
    expect(await ff.numberVariation("number-flag", 0)).toBe(42);
    expect(await ff.jsonVariation("json-flag", { ratio: 0 })).toStrictEqual({
      ratio: 0.5,
    });
  });

  it("falls back to the default on a type mismatch", async () => {
    expect(await make().stringVariation("bool-flag", "default")).toBe("default");
  });

  it("evaluates via the generic primitive", async () => {
    expect(await make().evaluate("number-flag", 0)).toBe(42);
  });

  it("forwards the evaluation context's targeting key to the client", async () => {
    const ff = new OpenFeatureFeatureFlagManager(
      fakeClient({ "new-checkout": false }, { "u-1": { "new-checkout": true } }),
    );
    expect(await ff.boolVariation("new-checkout", false)).toBe(false);
    expect(await ff.boolVariation("new-checkout", false, { key: "u-1" })).toBe(true);
  });

  it("returns an empty allFlags map (no enumeration in the OpenFeature contract)", async () => {
    expect(await make().allFlags()).toStrictEqual({});
  });
});

describe("toOpenFeatureContext", () => {
  it("maps key onto targetingKey and merges attributes", () => {
    const context: EvaluationContext = {
      key: "u-1",
      attributes: { plan: "enterprise", region: "eu" },
    };
    expect(toOpenFeatureContext(context)).toStrictEqual({
      targetingKey: "u-1",
      plan: "enterprise",
      region: "eu",
    });
  });

  it("lets key win over an attribute literally named targetingKey", () => {
    expect(
      toOpenFeatureContext({ key: "real", attributes: { targetingKey: "stale" } }),
    ).toStrictEqual({ targetingKey: "real" });
  });

  it("returns an empty context when none is supplied", () => {
    expect(toOpenFeatureContext()).toStrictEqual({});
  });
});
