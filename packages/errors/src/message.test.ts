import { describe, expect, it } from "vitest";

import { messageOf } from "./message.js";

describe("messageOf", () => {
  it("returns an Error's message", () => {
    expect(messageOf(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-Error values", () => {
    expect(messageOf("nope")).toBe("nope");
    expect(messageOf(42)).toBe("42");
    expect(messageOf(undefined)).toBe("undefined");
    expect(messageOf({})).toBe("[object Object]");
  });
});
