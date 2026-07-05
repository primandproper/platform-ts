import { describe, expect, it } from "vitest";

import { AnalyticsConfigSchema } from "./config.js";

describe("AnalyticsConfigSchema", () => {
  it("defaults to the noop provider", () => {
    expect(AnalyticsConfigSchema.parse({}).provider).toBe("noop");
  });

  it("requires segment config when the provider is segment", () => {
    expect(() => AnalyticsConfigSchema.parse({ provider: "segment" })).toThrow();
    expect(
      AnalyticsConfigSchema.parse({ provider: "segment", segment: { writeKey: "wk" } })
        .provider,
    ).toBe("segment");
  });

  it("requires posthog config when the provider is posthog", () => {
    expect(() => AnalyticsConfigSchema.parse({ provider: "posthog" })).toThrow();
    expect(
      AnalyticsConfigSchema.parse({ provider: "posthog", posthog: { apiKey: "k" } })
        .provider,
    ).toBe("posthog");
  });
});
