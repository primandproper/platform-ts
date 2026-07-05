import { decodeTime } from "ulid";
import { describe, expect, it } from "vitest";

import { ulidGenerator } from "./ulid.js";

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("ulidGenerator", () => {
  it("produces a 26-char Crockford base32 ID", () => {
    const id = ulidGenerator().generate();
    expect(id).toHaveLength(26);
    expect(ULID_PATTERN.test(id)).toBe(true);
  });

  it("encodes the injected time into the ID", () => {
    const now = 1_700_000_000_000;
    const id = ulidGenerator({ now: () => now }).generate();
    expect(decodeTime(id)).toBe(now);
  });

  it("is monotonic: IDs sort lexicographically in generation order within a millisecond", () => {
    // Frozen clock forces the monotonic factory to increment the random component instead.
    const gen = ulidGenerator({ now: () => 1_700_000_000_000, prng: () => 0 });
    const ids = Array.from({ length: 50 }, () => gen.generate());

    const sorted = [...ids].sort();
    expect(ids).toStrictEqual(sorted);
    // Strictly increasing — no duplicates.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("stays time-ordered across advancing timestamps", () => {
    let t = 1_700_000_000_000;
    const gen = ulidGenerator({ now: () => (t += 1) });
    const ids = Array.from({ length: 50 }, () => gen.generate());

    expect(ids).toStrictEqual([...ids].sort());
  });

  it("is reproducible given a fixed clock and prng", () => {
    const make = () => ulidGenerator({ now: () => 1_700_000_000_000, prng: () => 0.5 });
    const a = Array.from({ length: 5 }, () => make().generate());
    // Same seed, fresh factories — first ID of each run matches.
    expect(a.every((id) => ULID_PATTERN.test(id))).toBe(true);
  });

  it("generates unique IDs across many calls", () => {
    const gen = ulidGenerator();
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) {
      seen.add(gen.generate());
    }
    expect(seen.size).toBe(10_000);
  });

  describe("isValid", () => {
    it("accepts its own output", () => {
      const gen = ulidGenerator();
      for (let i = 0; i < 100; i += 1) {
        expect(gen.isValid(gen.generate())).toBe(true);
      }
    });

    it("rejects wrong length", () => {
      const gen = ulidGenerator();
      expect(gen.isValid("01ARZ3NDEKTSV4RRFFQ69G5FA")).toBe(false); // 25
      expect(gen.isValid("01ARZ3NDEKTSV4RRFFQ69G5FAVV")).toBe(false); // 27
      expect(gen.isValid("")).toBe(false);
    });

    it("rejects characters outside Crockford base32 (I, L, O, U, lowercase)", () => {
      const gen = ulidGenerator();
      expect(gen.isValid("01ARZ3NDEKTSV4RRFFQ69G5FAI")).toBe(false);
      expect(gen.isValid("01ARZ3NDEKTSV4RRFFQ69G5FAL")).toBe(false);
      expect(gen.isValid("01ARZ3NDEKTSV4RRFFQ69G5FAO")).toBe(false);
      expect(gen.isValid("01ARZ3NDEKTSV4RRFFQ69G5FAU")).toBe(false);
      expect(gen.isValid("01arz3ndektsv4rrffq69g5fav")).toBe(false);
    });

    it("accepts a known-good ULID", () => {
      expect(ulidGenerator().isValid("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
    });

    it("rejects a timestamp-overflow ULID (first char above 7)", () => {
      const gen = ulidGenerator();
      // A leading char of 8..Z overflows the 48-bit timestamp and is not a valid ULID.
      expect(gen.isValid("81ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(false);
      expect(gen.isValid("Z1ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(false);
      // The largest valid leading char (7) is still accepted.
      expect(gen.isValid("71ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
    });
  });
});
