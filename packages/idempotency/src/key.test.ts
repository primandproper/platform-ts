import { isPlatformError } from "@primandproper/errors";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_KEY_LENGTH,
  IdempotencyErrorCode,
  newIdempotencyKey,
  parseIdempotencyKey,
  validateIdempotencyKey,
} from "./key.js";

/** Asserts `fn` throws a PlatformError carrying `code`. */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(isPlatformError(err, code)).toBe(true);
    return;
  }
  expect.unreachable(`expected a ${code} error`);
}

describe("newIdempotencyKey", () => {
  it("mints a usable key", () => {
    const key = newIdempotencyKey();
    expect(key).not.toBe("");
    expect(() => {
      validateIdempotencyKey(key);
    }).not.toThrow();
  });

  it("mints a distinct key per call — which is why it belongs outside the retry loop", () => {
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
  });

  it("takes an injectable generator", () => {
    expect(newIdempotencyKey({ generate: () => "pinned" })).toBe("pinned");
  });
});

describe("validateIdempotencyKey", () => {
  it("accepts the shapes third-party clients actually send", () => {
    for (const key of [
      "3f0b1d5e-7c1a-4a5e-9d1e-2b3c4d5e6f70",
      "cv0j2q9c00000356m1abcdefg",
      "abc-_.~123",
    ]) {
      expect(() => {
        validateIdempotencyKey(key);
      }).not.toThrow();
    }
  });

  it("rejects an empty key", () => {
    expectCode(() => {
      validateIdempotencyKey("");
    }, IdempotencyErrorCode.keyRequired);
  });

  it("rejects a key past the maximum length", () => {
    expectCode(() => {
      validateIdempotencyKey("a".repeat(DEFAULT_MAX_KEY_LENGTH + 1));
    }, IdempotencyErrorCode.keyTooLong);
  });

  it("honours a custom maximum, and a non-positive one disables the check", () => {
    expectCode(() => {
      validateIdempotencyKey("abcd", 3);
    }, IdempotencyErrorCode.keyTooLong);
    expect(() => {
      validateIdempotencyKey("a".repeat(10_000), 0);
    }).not.toThrow();
  });

  it("rejects characters that travel badly in a header or a store key", () => {
    for (const key of ["with space", "tab\there", "newline\n", "nul\0", "emoji🙂", "é"]) {
      expectCode(() => {
        validateIdempotencyKey(key);
      }, IdempotencyErrorCode.keyInvalid);
    }
  });
});

describe("parseIdempotencyKey", () => {
  it("returns the branded key when valid", () => {
    expect(parseIdempotencyKey("abc123")).toBe("abc123");
  });

  it("throws on an unusable key rather than branding it", () => {
    expectCode(() => parseIdempotencyKey("bad key"), IdempotencyErrorCode.keyInvalid);
  });
});
