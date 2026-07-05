import {
  OpenFeature,
  type Client,
  type EvaluationDetails,
  type Provider,
} from "@openfeature/server-sdk";
import type { Logger } from "@primandproper/observability";
import { describe, expect, it } from "vitest";

import type { EvaluationContext, FlagValue } from "../featureflags.js";

import { OpenFeatureFeatureFlagManager, toOpenFeatureContext } from "./openfeature.js";

/**
 * A minimal fake OpenFeature client backed by a flag table. Like a real provider, it returns
 * the caller's default when a flag is absent or holds a value of a different runtime type, so
 * the adapter's type-routing and fallback behavior can be exercised without a network SDK. Uses
 * the `*Details` methods the manager now calls (FLAG-1).
 */
function fakeClient(
  flags: Record<string, FlagValue>,
  byTargetingKey?: Record<string, Record<string, FlagValue>>,
): Client {
  const pick = (
    key: string,
    def: FlagValue,
    type: string,
    ctxKey?: string,
  ): EvaluationDetails<FlagValue> => {
    const table = ctxKey !== undefined ? (byTargetingKey?.[ctxKey] ?? flags) : flags;
    const value = table[key];
    return {
      flagKey: key,
      flagMetadata: {},
      value: typeof value === type ? value : def,
      reason: "STATIC",
    } as EvaluationDetails<FlagValue>;
  };
  return {
    getBooleanDetails: (k: string, d: boolean, c?: { targetingKey?: string }) =>
      Promise.resolve(pick(k, d, "boolean", c?.targetingKey)),
    getStringDetails: (k: string, d: string, c?: { targetingKey?: string }) =>
      Promise.resolve(pick(k, d, "string", c?.targetingKey)),
    getNumberDetails: (k: string, d: number, c?: { targetingKey?: string }) =>
      Promise.resolve(pick(k, d, "number", c?.targetingKey)),
    getObjectDetails: (k: string, d: FlagValue, c?: { targetingKey?: string }) =>
      Promise.resolve(pick(k, d, "object", c?.targetingKey)),
  } as unknown as Client;
}

/** A logger that records warn lines so the error path can be asserted. */
function recordingLogger(): {
  logger: Logger;
  warns: { msg: string; values?: unknown }[];
} {
  const warns: { msg: string; values?: unknown }[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (msg, values) => warns.push({ msg, values }),
    error: () => undefined,
    with: () => logger,
    child: () => logger,
    withSpan: () => logger,
  };
  return { logger, warns };
}

/** A meter provider whose counter records every add(), for asserting the error counter. */
function recordingMetrics(): {
  metrics: never;
  adds: { value: number; attrs?: unknown }[];
} {
  const adds: { value: number; attrs?: unknown }[] = [];
  const counter = {
    add: (value: number, attrs?: unknown) => adds.push({ value, attrs }),
  };
  const meter = {
    createCounter: () => counter,
    createUpDownCounter: () => counter,
    createHistogram: () => ({ record: () => undefined }),
    createGauge: () => ({ record: () => undefined }),
  };
  return { metrics: { getMeter: () => meter } as unknown as never, adds };
}

/** A client whose evaluation always errors, mirroring a down provider (FLAG-1). */
function erroringClient(): Client {
  const details = (value: FlagValue): EvaluationDetails<FlagValue> =>
    ({
      flagKey: "k",
      flagMetadata: {},
      value,
      reason: "ERROR",
      errorCode: "PROVIDER_NOT_READY",
      errorMessage: "provider is down",
    }) as EvaluationDetails<FlagValue>;
  return {
    getBooleanDetails: (_k: string, d: boolean) => Promise.resolve(details(d)),
    getStringDetails: (_k: string, d: string) => Promise.resolve(details(d)),
    getNumberDetails: (_k: string, d: number) => Promise.resolve(details(d)),
    getObjectDetails: (_k: string, d: FlagValue) => Promise.resolve(details(d)),
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

describe("OpenFeatureFeatureFlagManager error visibility (FLAG-1)", () => {
  it("logs and counts an evaluation error, still returning the default", async () => {
    const { logger, warns } = recordingLogger();
    const { metrics, adds } = recordingMetrics();
    const mgr = new OpenFeatureFeatureFlagManager(erroringClient(), { logger, metrics });

    const result = await mgr.evaluate("kill-switch", false);

    expect(result).toBe(false); // still returns the caller's default
    expect(adds).toHaveLength(1);
    expect(adds[0]?.attrs).toStrictEqual({ error_code: "PROVIDER_NOT_READY" });
    expect(warns).toHaveLength(1);
    expect(warns[0]?.values).toMatchObject({
      key: "kill-switch",
      error_code: "PROVIDER_NOT_READY",
    });
  });

  it("stays quiet on a clean evaluation", async () => {
    const { logger, warns } = recordingLogger();
    const { metrics, adds } = recordingMetrics();
    const mgr = new OpenFeatureFeatureFlagManager(fakeClient(flags), { logger, metrics });

    expect(await mgr.evaluate("bool-flag", false)).toBe(true);
    expect(adds).toHaveLength(0);
    expect(warns).toHaveLength(0);
  });
});

/** A minimal OpenFeature provider that records when OpenFeature shuts it down. */
function closableProvider(onClose: () => void): Provider {
  return {
    metadata: { name: "fake-closable" },
    onClose: () => {
      onClose();
      return Promise.resolve();
    },
  } as unknown as Provider;
}

describe("OpenFeatureFeatureFlagManager close (LC-5/LC-6)", () => {
  it("shuts down its own domain's provider", async () => {
    let closed = false;
    const domain = "test_ff_close_1";
    await OpenFeature.setProviderAndWait(
      domain,
      closableProvider(() => (closed = true)),
    );
    const mgr = new OpenFeatureFeatureFlagManager(
      OpenFeature.getClient(domain),
      {},
      domain,
    );

    await mgr.close();

    expect(closed).toBe(true);
  });

  it("closing one domain leaves another manager's provider untouched", async () => {
    let closedA = false;
    let closedB = false;
    await OpenFeature.setProviderAndWait(
      "test_ff_iso_a",
      closableProvider(() => (closedA = true)),
    );
    await OpenFeature.setProviderAndWait(
      "test_ff_iso_b",
      closableProvider(() => (closedB = true)),
    );
    const a = new OpenFeatureFeatureFlagManager(
      OpenFeature.getClient("test_ff_iso_a"),
      {},
      "test_ff_iso_a",
    );

    await a.close();

    expect(closedA).toBe(true);
    expect(closedB).toBe(false); // per-call unique domains keep managers isolated
  });

  it("is a no-op for a domainless manager (does not throw)", async () => {
    await expect(
      new OpenFeatureFeatureFlagManager(fakeClient(flags)).close(),
    ).resolves.toBeUndefined();
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
