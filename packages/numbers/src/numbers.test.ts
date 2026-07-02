import { describe, expect, it } from "vitest";

import {
  clamp,
  compound,
  percentChange,
  percentOf,
  round,
  roundToNearest,
  scale,
} from "./numbers.js";

describe("round", () => {
  it("rounds to whole numbers by default", () => {
    expect(round(2.4)).toBe(2);
    expect(round(2.5)).toBe(3);
    expect(round(2.6)).toBe(3);
  });

  it("handles the classic binary-float cases", () => {
    expect(round(1.005, 2)).toBe(1.01);
    expect(round(2.675, 2)).toBe(2.68);
    expect(round(0.615, 2)).toBe(0.62);
  });

  it("rounds half away from zero, symmetrically for negatives", () => {
    expect(round(0.5)).toBe(1);
    expect(round(-0.5)).toBe(-1);
    expect(round(-2.5)).toBe(-3);
    expect(round(-1.005, 2)).toBe(-1.01);
  });

  it("returns +0 for zero, never -0", () => {
    expect(round(0)).toBe(0);
    expect(Object.is(round(-0), 0)).toBe(true);
    expect(Object.is(round(-0.0001, 2), 0)).toBe(true);
  });

  it("is a no-op when already at or below the precision", () => {
    expect(round(3.14159, 5)).toBe(3.14159);
    expect(round(42, 2)).toBe(42);
  });

  it("rejects non-finite values and bad precision", () => {
    expect(() => round(NaN)).toThrow(RangeError);
    expect(() => round(Infinity)).toThrow(RangeError);
    expect(() => round(1.5, -1)).toThrow(RangeError);
    expect(() => round(1.5, 1.5)).toThrow(RangeError);
  });
});

describe("roundToNearest", () => {
  it("rounds to the nearest multiple of step", () => {
    expect(roundToNearest(7, 5)).toBe(5);
    expect(roundToNearest(8, 5)).toBe(10);
    expect(roundToNearest(2.5, 5)).toBe(5);
    expect(roundToNearest(12, 0.25)).toBe(12);
    expect(roundToNearest(12.1, 0.25)).toBe(12);
    expect(roundToNearest(12.13, 0.25)).toBe(12.25);
  });

  it("works for negatives, rounding half away from zero", () => {
    expect(roundToNearest(-7, 5)).toBe(-5);
    expect(roundToNearest(-8, 5)).toBe(-10);
    expect(roundToNearest(-2.5, 5)).toBe(-5);
  });

  it("avoids float drift in the result", () => {
    expect(roundToNearest(0.3, 0.1)).toBe(0.3);
    expect(roundToNearest(1.1, 0.1)).toBe(1.1);
  });

  it("returns zero for zero input", () => {
    expect(roundToNearest(0, 5)).toBe(0);
  });

  it("rejects non-positive or non-finite step", () => {
    expect(() => roundToNearest(10, 0)).toThrow(RangeError);
    expect(() => roundToNearest(10, -1)).toThrow(RangeError);
    expect(() => roundToNearest(10, Infinity)).toThrow(RangeError);
    expect(() => roundToNearest(NaN, 5)).toThrow(RangeError);
  });
});

describe("clamp", () => {
  it("passes values within range through unchanged", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it("clamps at both bounds inclusively", () => {
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it("handles negative ranges", () => {
    expect(clamp(-5, -10, -1)).toBe(-5);
    expect(clamp(-20, -10, -1)).toBe(-10);
  });

  it("permits a degenerate min===max range", () => {
    expect(clamp(7, 3, 3)).toBe(3);
  });

  it("rejects inverted ranges and non-finite args", () => {
    expect(() => clamp(5, 10, 0)).toThrow(RangeError);
    expect(() => clamp(NaN, 0, 10)).toThrow(RangeError);
    expect(() => clamp(5, NaN, 10)).toThrow(RangeError);
  });
});

describe("scale", () => {
  it("remaps linearly between ranges", () => {
    expect(scale(5, 0, 10, 0, 100)).toBe(50);
    expect(scale(0, 0, 10, 0, 100)).toBe(0);
    expect(scale(10, 0, 10, 0, 100)).toBe(100);
  });

  it("extrapolates outside the source range", () => {
    expect(scale(15, 0, 10, 0, 100)).toBe(150);
    expect(scale(-5, 0, 10, 0, 100)).toBe(-50);
  });

  it("supports inverted and negative target ranges", () => {
    expect(scale(0, 0, 10, 100, 0)).toBe(100);
    expect(scale(10, 0, 10, 100, 0)).toBe(0);
    expect(scale(0, -10, 10, -1, 1)).toBe(0);
  });

  it("throws on a zero-width source range", () => {
    expect(() => scale(5, 5, 5, 0, 100)).toThrow(RangeError);
  });

  it("rejects non-finite args", () => {
    expect(() => scale(NaN, 0, 10, 0, 100)).toThrow(RangeError);
    expect(() => scale(5, 0, Infinity, 0, 100)).toThrow(RangeError);
  });
});

describe("percentChange", () => {
  it("computes increases and decreases", () => {
    expect(percentChange(100, 150)).toBe(50);
    expect(percentChange(100, 50)).toBe(-50);
    expect(percentChange(100, 100)).toBe(0);
  });

  it("handles negative baselines", () => {
    expect(percentChange(-100, -50)).toBe(-50);
  });

  it("throws when the baseline is zero (division by zero)", () => {
    expect(() => percentChange(0, 10)).toThrow(RangeError);
  });

  it("rejects non-finite args", () => {
    expect(() => percentChange(NaN, 10)).toThrow(RangeError);
    expect(() => percentChange(10, Infinity)).toThrow(RangeError);
  });
});

describe("percentOf", () => {
  it("computes part as a percentage of whole", () => {
    expect(percentOf(25, 200)).toBe(12.5);
    expect(percentOf(50, 50)).toBe(100);
    expect(percentOf(0, 50)).toBe(0);
  });

  it("throws when whole is zero (division by zero)", () => {
    expect(() => percentOf(10, 0)).toThrow(RangeError);
  });

  it("rejects non-finite args", () => {
    expect(() => percentOf(NaN, 10)).toThrow(RangeError);
  });
});

describe("compound", () => {
  it("grows principal over periods", () => {
    expect(compound(1000, 0.05, 0)).toBe(1000);
    expect(compound(1000, 0.05, 1)).toBe(1050);
    expect(round(compound(1000, 0.05, 10), 2)).toBe(1628.89);
  });

  it("handles negative rates (losses)", () => {
    expect(compound(1000, -0.1, 1)).toBe(900);
  });

  it("rejects non-integer or negative periods", () => {
    expect(() => compound(1000, 0.05, -1)).toThrow(RangeError);
    expect(() => compound(1000, 0.05, 1.5)).toThrow(RangeError);
  });

  it("rejects a rate of -100% or worse", () => {
    expect(() => compound(1000, -1, 5)).toThrow(RangeError);
    expect(() => compound(1000, -2, 5)).toThrow(RangeError);
  });

  it("rejects non-finite args", () => {
    expect(() => compound(NaN, 0.05, 5)).toThrow(RangeError);
    expect(() => compound(1000, Infinity, 5)).toThrow(RangeError);
  });
});
