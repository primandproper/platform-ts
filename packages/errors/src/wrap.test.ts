import { describe, expect, it } from "vitest";

import { isPlatformError, PlatformError } from "./platform-error.js";
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

  it("preserves a PlatformError's code when wrapping so it still matches", () => {
    const original = new PlatformError("secrets/missing", "no such key");
    const wrapped = wrap("load config failed", original);

    expect(wrapped.message).toBe("load config failed: no such key");
    expect(wrapped.cause).toBe(original);
    expect(isPlatformError(wrapped, "secrets/missing")).toBe(true);
  });
});
