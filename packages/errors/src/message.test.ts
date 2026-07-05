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
  });

  it("reads a string message property off a thrown plain object", () => {
    expect(messageOf({ message: "kaboom" })).toBe("kaboom");
  });

  it("JSON-stringifies a message-less plain object instead of [object Object]", () => {
    expect(messageOf({ code: 7 })).toBe('{"code":7}');
    expect(messageOf({})).toBe("{}");
  });

  it("falls back to String when the object cannot be serialized", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(messageOf(circular)).toBe("[object Object]");
  });
});
