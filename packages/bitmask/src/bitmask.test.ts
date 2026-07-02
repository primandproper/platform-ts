import { describe, expect, it } from "vitest";

import { Bitmask } from "./bitmask.js";

describe("Bitmask construction", () => {
  it("empty has no bits set", () => {
    const mask = Bitmask.empty();
    expect(mask.isEmpty()).toBe(true);
    expect(mask.count()).toBe(0);
    expect(mask.toBigInt()).toBe(0n);
  });

  it("of wraps a number value", () => {
    expect(Bitmask.of(0b1010).toBigInt()).toBe(10n);
  });

  it("of wraps a bigint value", () => {
    expect(Bitmask.of(255n).toBigInt()).toBe(255n);
  });

  it("fromBits sets the given positions", () => {
    const mask = Bitmask.fromBits(0, 2, 4);
    expect(mask.toBigInt()).toBe(0b10101n);
    expect(mask.count()).toBe(3);
  });

  it("fromBits with no positions is empty", () => {
    expect(Bitmask.fromBits().isEmpty()).toBe(true);
  });

  it("of rejects a negative number", () => {
    expect(() => Bitmask.of(-1)).toThrow(RangeError);
  });

  it("of rejects a negative bigint", () => {
    expect(() => Bitmask.of(-1n)).toThrow(RangeError);
  });

  it("of rejects a non-integer number", () => {
    expect(() => Bitmask.of(1.5)).toThrow(RangeError);
  });
});

describe("Bitmask queries", () => {
  const mask = Bitmask.fromBits(1, 3);

  it("has reports set and unset bits", () => {
    expect(mask.has(1)).toBe(true);
    expect(mask.has(3)).toBe(true);
    expect(mask.has(0)).toBe(false);
    expect(mask.has(2)).toBe(false);
  });

  it("hasAll is true only when every other bit is present", () => {
    expect(mask.hasAll(Bitmask.fromBits(1))).toBe(true);
    expect(mask.hasAll(Bitmask.fromBits(1, 3))).toBe(true);
    expect(mask.hasAll(Bitmask.fromBits(1, 2))).toBe(false);
    expect(mask.hasAll(Bitmask.empty())).toBe(true);
  });

  it("hasAny is true when at least one other bit is present", () => {
    expect(mask.hasAny(Bitmask.fromBits(1, 2))).toBe(true);
    expect(mask.hasAny(Bitmask.fromBits(0, 2))).toBe(false);
    expect(mask.hasAny(Bitmask.empty())).toBe(false);
  });

  it("count is the popcount", () => {
    expect(Bitmask.of(0n).count()).toBe(0);
    expect(Bitmask.of(0b1111n).count()).toBe(4);
    expect(Bitmask.fromBits(0, 7, 63, 100).count()).toBe(4);
  });

  it("toString renders in the requested radix", () => {
    const m = Bitmask.of(255n);
    expect(m.toString()).toBe("11111111");
    expect(m.toString(16)).toBe("ff");
    expect(m.toString(10)).toBe("255");
  });

  it("equals compares the underlying bits", () => {
    expect(Bitmask.fromBits(1, 3).equals(Bitmask.of(0b1010n))).toBe(true);
    expect(Bitmask.fromBits(1, 3).equals(Bitmask.fromBits(1))).toBe(false);
  });
});

describe("Bitmask transforms are immutable", () => {
  it("set returns a new mask and leaves the original unchanged", () => {
    const original = Bitmask.empty();
    const next = original.set(2);
    expect(next.has(2)).toBe(true);
    expect(original.has(2)).toBe(false);
    expect(original.isEmpty()).toBe(true);
  });

  it("clear returns a new mask and leaves the original unchanged", () => {
    const original = Bitmask.fromBits(0, 1);
    const next = original.clear(0);
    expect(next.has(0)).toBe(false);
    expect(original.has(0)).toBe(true);
  });

  it("toggle flips a bit without mutating the original", () => {
    const original = Bitmask.fromBits(5);
    expect(original.toggle(5).has(5)).toBe(false);
    expect(original.toggle(6).has(6)).toBe(true);
    expect(original.has(5)).toBe(true);
  });

  it("union/intersection/difference do not mutate operands", () => {
    const a = Bitmask.fromBits(0, 1);
    const b = Bitmask.fromBits(1, 2);
    a.union(b);
    a.intersection(b);
    a.difference(b);
    expect(a.toBigInt()).toBe(0b011n);
    expect(b.toBigInt()).toBe(0b110n);
  });
});

describe("Bitmask set algebra", () => {
  const a = Bitmask.fromBits(0, 1, 2);
  const b = Bitmask.fromBits(2, 3, 4);

  it("union is the bitwise OR", () => {
    expect(a.union(b).toBigInt()).toBe(0b11111n);
  });

  it("intersection is the bitwise AND", () => {
    expect(a.intersection(b).toBigInt()).toBe(0b00100n);
  });

  it("difference removes the other's bits", () => {
    expect(a.difference(b).toBigInt()).toBe(0b00011n);
    expect(b.difference(a).toBigInt()).toBe(0b11000n);
  });

  it("union with empty is identity", () => {
    expect(a.union(Bitmask.empty()).equals(a)).toBe(true);
  });

  it("intersection with empty is empty", () => {
    expect(a.intersection(Bitmask.empty()).isEmpty()).toBe(true);
  });
});

describe("Bitmask high bit positions (bigint proof)", () => {
  it("handles bits far beyond 32 without sign coercion", () => {
    const mask = Bitmask.empty().set(100);
    expect(mask.has(100)).toBe(true);
    expect(mask.toBigInt()).toBe(1n << 100n);
    expect(mask.count()).toBe(1);
  });

  it("set/clear round-trips a high bit", () => {
    const mask = Bitmask.fromBits(63, 64, 200);
    expect(mask.count()).toBe(3);
    expect(mask.clear(200).has(200)).toBe(false);
    expect(mask.clear(200).has(64)).toBe(true);
  });

  it("bit 31 and 32 are independent (no 32-bit overflow)", () => {
    const mask = Bitmask.fromBits(31, 32);
    expect(mask.has(31)).toBe(true);
    expect(mask.has(32)).toBe(true);
    expect(mask.count()).toBe(2);
  });
});

describe("Bitmask position validation", () => {
  it("has rejects negative positions", () => {
    expect(() => Bitmask.empty().has(-1)).toThrow(RangeError);
  });

  it("set rejects negative positions", () => {
    expect(() => Bitmask.empty().set(-5)).toThrow(RangeError);
  });

  it("clear rejects non-integer positions", () => {
    expect(() => Bitmask.empty().clear(2.5)).toThrow(RangeError);
  });

  it("toggle rejects non-integer positions", () => {
    expect(() => Bitmask.empty().toggle(Number.NaN)).toThrow(RangeError);
  });

  it("fromBits rejects negative positions", () => {
    expect(() => Bitmask.fromBits(0, -1)).toThrow(RangeError);
  });
});
