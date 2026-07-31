import { describe, expect, it } from "vitest";

import { IdempotencyConfigSchema } from "./config.js";

describe("IdempotencyConfigSchema", () => {
  it("defaults to a day of retention, a two-minute claim, and failing closed", () => {
    expect(IdempotencyConfigSchema.parse({})).toEqual({
      keyPrefix: "idempotency:",
      ttlMs: 86_400_000,
      inFlightTtlMs: 120_000,
      maxKeyLength: 255,
      storeFailurePolicy: "fail-closed",
      lockTtlMs: 5_000,
      lockWaitMs: 2_000,
      lockPollMs: 25,
    });
  });

  it("honours an empty key prefix rather than treating it as unset", () => {
    // Opting out of namespacing is a legitimate choice — e.g. a store used for nothing else.
    expect(IdempotencyConfigSchema.parse({ keyPrefix: "" }).keyPrefix).toBe("");
  });

  it("rejects a non-positive TTL", () => {
    expect(() => IdempotencyConfigSchema.parse({ ttlMs: 0 })).toThrow();
    expect(() => IdempotencyConfigSchema.parse({ inFlightTtlMs: -1 })).toThrow();
  });

  it("allows a zero key-length cap (disabling the check) and a zero lock wait", () => {
    expect(IdempotencyConfigSchema.parse({ maxKeyLength: 0 }).maxKeyLength).toBe(0);
    expect(IdempotencyConfigSchema.parse({ lockWaitMs: 0 }).lockWaitMs).toBe(0);
  });

  it("rejects an unknown store failure policy", () => {
    expect(() =>
      IdempotencyConfigSchema.parse({ storeFailurePolicy: "maybe" }),
    ).toThrow();
  });
});
