import { describe, expect, it } from "vitest";

import { isPlatformError, PlatformError } from "./platform-error.js";

class MissingThing extends PlatformError {
  constructor(key: string) {
    super("test/missing", `missing: ${key}`);
    this.name = "MissingThing";
  }
}

describe("PlatformError", () => {
  it("sets code, message, name, and cause", () => {
    const cause = new Error("root");
    const err = new PlatformError("test/code", "boom", { cause });

    expect(err.code).toBe("test/code");
    expect(err.message).toBe("boom");
    expect(err.name).toBe("PlatformError");
    expect(err.cause).toBe(cause);
  });

  it("preserves the subclass prototype chain for instanceof", () => {
    const err = new MissingThing("token");

    expect(err).toBeInstanceOf(MissingThing);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.name).toBe("MissingThing");
    expect(err.code).toBe("test/missing");
  });
});

describe("isPlatformError", () => {
  it("recognizes instances and subclass instances", () => {
    expect(isPlatformError(new PlatformError("a", "x"))).toBe(true);
    expect(isPlatformError(new MissingThing("k"))).toBe(true);
  });

  it("rejects plain errors and non-objects", () => {
    expect(isPlatformError(new Error("plain"))).toBe(false);
    expect(isPlatformError("nope")).toBe(false);
    expect(isPlatformError(null)).toBe(false);
    expect(isPlatformError(undefined)).toBe(false);
  });

  it("narrows by code when given", () => {
    const err = new MissingThing("k");
    expect(isPlatformError(err, "test/missing")).toBe(true);
    expect(isPlatformError(err, "other/code")).toBe(false);
  });

  it("matches by brand, not instanceof — a foreign copy still passes", () => {
    // Simulates a PlatformError from a duplicated/other-realm copy of this package: same registered
    // brand symbol, unrelated prototype. instanceof would fail here; the brand check must not.
    const foreign = {
      [Symbol.for("@primandproper/errors.PlatformError")]: true,
      code: "secrets/missing",
    };

    expect(isPlatformError(foreign)).toBe(true);
    expect(isPlatformError(foreign, "secrets/missing")).toBe(true);
    expect(foreign instanceof PlatformError).toBe(false);
  });
});
