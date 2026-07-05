/**
 * Universal number utilities: rounding, scaling, and a little yield math.
 * Pure functions, no dependencies. Non-finite inputs are rejected with a
 * `RangeError`; nonsensical arguments (negative decimal places, bad ranges)
 * throw `RangeError` too. Nothing here silently returns `NaN`.
 */

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be a finite number, got ${String(value)}`);
  }
}

/**
 * Multiplies `n` by `10 ** exp`. Prefers the exact decimal-string `e`-shift (which dodges the
 * float multiplication error that plagues `n * 10 ** exp`), but that trick yields `NaN` when
 * `n.toString()` is itself in exponential notation — which JS uses for `|n| >= 1e21` or
 * `|n| < 1e-6`. For those magnitudes it falls back to plain scaling, where trailing-digit
 * precision is moot anyway.
 */
function shiftPow10(n: number, exp: number): number {
  const s = n.toString();
  if (s.includes("e")) {
    return n * 10 ** exp;
  }
  return Number(`${s}e${exp.toString()}`);
}

/**
 * Rounds `value` to `decimals` places using round-half-away-from-zero, correcting
 * for binary-float representation so `round(1.005, 2) === 1.01` and
 * `round(2.675, 2) === 2.68`. Mirrors the Go platform's `Round`.
 */
export function round(value: number, decimals = 0): number {
  assertFinite(value, "value");
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(
      `decimals must be a non-negative integer, got ${String(decimals)}`,
    );
  }
  if (value === 0) return 0; // preserve +0, never emit -0
  const sign = value < 0 ? -1 : 1;
  // Scale via the exact `e`-shift to dodge the float multiplication error
  // (e.g. 1.005 * 100 === 100.49999...), falling back for exponential-notation
  // magnitudes so extreme inputs round instead of returning NaN.
  const shifted = shiftPow10(Math.abs(value), decimals);
  const rounded = Math.round(shifted);
  if (rounded === 0) return 0; // a magnitude that rounds to zero stays +0
  return sign * shiftPow10(rounded, -decimals);
}

/**
 * Rounds `value` to the nearest multiple of `step` (round-half-away-from-zero).
 * `step` must be a positive finite number.
 */
export function roundToNearest(value: number, step: number): number {
  assertFinite(value, "value");
  assertFinite(step, "step");
  if (step <= 0) {
    throw new RangeError(`step must be positive, got ${String(step)}`);
  }
  if (value === 0) return 0;
  const sign = value < 0 ? -1 : 1;
  const quotient = Math.round(Math.abs(value) / step);
  // Re-round to tame the float error introduced by the division/multiplication.
  return sign * round(quotient * step, 12);
}

/** Clamps `value` to the inclusive `[min, max]` range. Requires `min <= max`. */
export function clamp(value: number, min: number, max: number): number {
  assertFinite(value, "value");
  assertFinite(min, "min");
  assertFinite(max, "max");
  if (min > max) {
    throw new RangeError(`min (${String(min)}) must not exceed max (${String(max)})`);
  }
  return Math.min(Math.max(value, min), max);
}

/**
 * Linearly remaps `value` from the `[fromMin, fromMax]` range onto
 * `[toMin, toMax]`. A zero-width source range throws (the mapping is undefined).
 */
export function scale(
  value: number,
  fromMin: number,
  fromMax: number,
  toMin: number,
  toMax: number,
): number {
  assertFinite(value, "value");
  assertFinite(fromMin, "fromMin");
  assertFinite(fromMax, "fromMax");
  assertFinite(toMin, "toMin");
  assertFinite(toMax, "toMax");
  if (fromMin === fromMax) {
    throw new RangeError("source range has zero width; cannot scale");
  }
  const ratio = (value - fromMin) / (fromMax - fromMin);
  return toMin + ratio * (toMax - toMin);
}

/**
 * Percentage change from `from` to `to`, e.g. `percentChange(100, 150) === 50`.
 * A `from` of zero has no defined percent change and throws.
 */
export function percentChange(from: number, to: number): number {
  assertFinite(from, "from");
  assertFinite(to, "to");
  if (from === 0) {
    throw new RangeError("percentChange is undefined when `from` is zero");
  }
  return ((to - from) / from) * 100;
}

/**
 * `part` as a percentage of `whole`, e.g. `percentOf(25, 200) === 12.5`.
 * A `whole` of zero has no defined percentage and throws.
 */
export function percentOf(part: number, whole: number): number {
  assertFinite(part, "part");
  assertFinite(whole, "whole");
  if (whole === 0) {
    throw new RangeError("percentOf is undefined when `whole` is zero");
  }
  return (part / whole) * 100;
}

/**
 * Compound growth: the future value of `principal` growing at `ratePerPeriod`
 * (a fraction, e.g. `0.05` for 5%) over `periods` compounding periods —
 * `principal * (1 + ratePerPeriod) ** periods`. `periods` must be a
 * non-negative integer; `ratePerPeriod` must be > -1 (a -100%+ loss is undefined).
 */
export function compound(
  principal: number,
  ratePerPeriod: number,
  periods: number,
): number {
  assertFinite(principal, "principal");
  assertFinite(ratePerPeriod, "ratePerPeriod");
  if (!Number.isInteger(periods) || periods < 0) {
    throw new RangeError(
      `periods must be a non-negative integer, got ${String(periods)}`,
    );
  }
  if (ratePerPeriod <= -1) {
    throw new RangeError(
      `ratePerPeriod must be greater than -1, got ${String(ratePerPeriod)}`,
    );
  }
  return principal * (1 + ratePerPeriod) ** periods;
}
