import { describe, expect, it } from "vitest";

import { hasValue, type IdempotentResult } from "./record.js";

describe("hasValue", () => {
  it("narrows the two outcomes that carry a value", () => {
    const executed: IdempotentResult<number> = { status: "executed", value: 1 };
    const replayed: IdempotentResult<number> = { status: "replayed", value: 2 };

    for (const result of [executed, replayed]) {
      expect(hasValue(result)).toBe(true);
      // The point of the guard: `result.value` is reachable without a cast in this branch.
      if (hasValue(result)) {
        expect(typeof result.value).toBe("number");
      }
    }
  });

  it("rejects the two outcomes that do not", () => {
    expect(hasValue<number>({ status: "in-flight" })).toBe(false);
    expect(hasValue<number>({ status: "fingerprint-mismatch" })).toBe(false);
  });
});
