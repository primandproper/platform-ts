import { describe, expect, it } from "vitest";

import { wrap } from "./wrap.js";

describe("wrap", () => {
  it("prefixes the original message", () => {
    expect(wrap("s3 get failed", new Error("timeout")).message).toBe(
      "s3 get failed: timeout",
    );
  });

  it("preserves the original as cause", () => {
    const original = new Error("timeout");
    expect(wrap("s3 get failed", original).cause).toBe(original);
  });

  it("wraps non-Error values cleanly", () => {
    const wrapped = wrap("redis publish failed", "ECONNREFUSED");
    expect(wrapped.message).toBe("redis publish failed: ECONNREFUSED");
    expect(wrapped.cause).toBe("ECONNREFUSED");
  });
});
