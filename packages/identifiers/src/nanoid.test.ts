import { urlAlphabet } from "nanoid";
import { describe, expect, it } from "vitest";

import { nanoidGenerator, type RandomBytes } from "./nanoid.js";

const defaults = { alphabet: urlAlphabet, size: 21 };

/** Deterministic byte source: a repeating ramp, enough to make output reproducible. */
function rampBytes(): RandomBytes {
  let n = 0;
  return (bytes: number) => {
    const out = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i += 1) {
      out[i] = n % 256;
      n += 7;
    }
    return out;
  };
}

describe("nanoidGenerator", () => {
  it("produces an ID of the configured length from the configured alphabet", () => {
    const gen = nanoidGenerator(defaults);
    const allowed = new Set(urlAlphabet);

    const id = gen.generate();
    expect(id).toHaveLength(21);
    for (const ch of id) {
      expect(allowed.has(ch)).toBe(true);
    }
  });

  it("honors a custom alphabet and size", () => {
    const gen = nanoidGenerator({ alphabet: "abc", size: 8 });
    const id = gen.generate();

    expect(id).toHaveLength(8);
    expect(/^[abc]{8}$/.test(id)).toBe(true);
  });

  it("generates unique IDs across many calls", () => {
    const gen = nanoidGenerator(defaults);
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) {
      seen.add(gen.generate());
    }
    expect(seen.size).toBe(10_000);
  });

  it("is reproducible given the same injected randomness", () => {
    const a = nanoidGenerator(defaults, { randomBytes: rampBytes() });
    const b = nanoidGenerator(defaults, { randomBytes: rampBytes() });

    const idsA = Array.from({ length: 5 }, () => a.generate());
    const idsB = Array.from({ length: 5 }, () => b.generate());
    expect(idsA).toStrictEqual(idsB);
    for (const id of idsA) {
      expect(id).toHaveLength(21);
    }
  });

  describe("isValid", () => {
    it("accepts its own output", () => {
      const gen = nanoidGenerator(defaults);
      for (let i = 0; i < 100; i += 1) {
        expect(gen.isValid(gen.generate())).toBe(true);
      }
    });

    it("rejects wrong length", () => {
      const gen = nanoidGenerator({ alphabet: "abc", size: 4 });
      expect(gen.isValid("abc")).toBe(false);
      expect(gen.isValid("abcaa")).toBe(false);
      expect(gen.isValid("")).toBe(false);
    });

    it("rejects characters outside the alphabet", () => {
      const gen = nanoidGenerator({ alphabet: "abc", size: 4 });
      expect(gen.isValid("abcd")).toBe(false);
      expect(gen.isValid("abc!")).toBe(false);
      expect(gen.isValid("aaaa")).toBe(true);
    });

    it("validates against the configured alphabet, not nanoid's default", () => {
      const gen = nanoidGenerator({ alphabet: "01", size: 3 });
      // '_' and '-' are in nanoid's default URL alphabet but not this one.
      expect(gen.isValid("0_1")).toBe(false);
      expect(gen.isValid("010")).toBe(true);
    });
  });
});
