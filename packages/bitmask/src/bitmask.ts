/**
 * An immutable bitmask over unsigned integers. Backed by `bigint` rather than
 * `number` because JS bitwise operators coerce to 32-bit *signed* ints, which breaks
 * unsigned semantics past bit 30/31; `bigint` keeps the mask truly unsigned and
 * arbitrarily wide. The analogue of the Go platform's generic `Bitmask`.
 *
 * Every transform returns a new {@link Bitmask}; instances are never mutated.
 */
export class Bitmask {
  readonly #bits: bigint;

  private constructor(bits: bigint) {
    this.#bits = bits;
  }

  /** The empty mask (no bits set). */
  static empty(): Bitmask {
    return new Bitmask(0n);
  }

  /** Wraps a raw value. Rejects negative values to preserve the unsigned invariant. */
  static of(value: bigint | number): Bitmask {
    const bits = toBigInt(value);
    if (bits < 0n) {
      throw new RangeError(`bitmask value must be non-negative, got ${String(value)}`);
    }
    return new Bitmask(bits);
  }

  /** Builds a mask with the given bit positions set. */
  static fromBits(...positions: number[]): Bitmask {
    let bits = 0n;
    for (const position of positions) {
      bits |= 1n << BigInt(assertPosition(position));
    }
    return new Bitmask(bits);
  }

  /** Whether the bit at `position` is set. */
  has(position: number): boolean {
    return (this.#bits & (1n << BigInt(assertPosition(position)))) !== 0n;
  }

  /** Whether every bit set in `other` is also set in this mask. */
  hasAll(other: Bitmask): boolean {
    return (this.#bits & other.#bits) === other.#bits;
  }

  /** Whether any bit set in `other` is also set in this mask. */
  hasAny(other: Bitmask): boolean {
    return (this.#bits & other.#bits) !== 0n;
  }

  /** Whether no bits are set. */
  isEmpty(): boolean {
    return this.#bits === 0n;
  }

  /** Number of set bits (popcount). */
  count(): number {
    let bits = this.#bits;
    let total = 0;
    while (bits !== 0n) {
      bits &= bits - 1n;
      total += 1;
    }
    return total;
  }

  /** The underlying value. */
  toBigInt(): bigint {
    return this.#bits;
  }

  /** String form of the underlying value in the given radix (default 2, binary). */
  toString(radix = 2): string {
    return this.#bits.toString(radix);
  }

  /** Whether two masks hold the same bits. */
  equals(other: Bitmask): boolean {
    return this.#bits === other.#bits;
  }

  /** A new mask with the bit at `position` set. */
  set(position: number): Bitmask {
    return new Bitmask(this.#bits | (1n << BigInt(assertPosition(position))));
  }

  /** A new mask with the bit at `position` cleared. */
  clear(position: number): Bitmask {
    return new Bitmask(this.#bits & ~(1n << BigInt(assertPosition(position))));
  }

  /** A new mask with the bit at `position` flipped. */
  toggle(position: number): Bitmask {
    return new Bitmask(this.#bits ^ (1n << BigInt(assertPosition(position))));
  }

  /** A new mask with the bits of both masks (bitwise OR). */
  union(other: Bitmask): Bitmask {
    return new Bitmask(this.#bits | other.#bits);
  }

  /** A new mask with only the bits common to both masks (bitwise AND). */
  intersection(other: Bitmask): Bitmask {
    return new Bitmask(this.#bits & other.#bits);
  }

  /** A new mask with this mask's bits that are not in `other` (bitwise AND-NOT). */
  difference(other: Bitmask): Bitmask {
    return new Bitmask(this.#bits & ~other.#bits);
  }
}

/** Validates a bit position is a non-negative integer, returning it for chaining. */
function assertPosition(position: number): number {
  if (!Number.isInteger(position) || position < 0) {
    throw new RangeError(
      `bit position must be a non-negative integer, got ${String(position)}`,
    );
  }
  return position;
}

/** Coerces a `number` to `bigint`, rejecting non-integers. */
function toBigInt(value: bigint | number): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (!Number.isInteger(value)) {
    throw new RangeError(`bitmask value must be an integer, got ${String(value)}`);
  }
  return BigInt(value);
}
