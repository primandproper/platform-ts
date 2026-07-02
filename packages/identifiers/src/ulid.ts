import { monotonicFactory, type PRNG, type ULIDFactory } from "ulid";

import type { IdentifierGenerator } from "./generator.js";

/** ULID is 26 chars of Crockford base32 (excludes I, L, O, U). */
const ULID_LENGTH = 26;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Injectable clock + randomness for deterministic ULID generation in tests. */
export interface UlidDeps {
  /** Pseudo-random number source in [0, 1); seeds the random component. */
  prng?: PRNG;
  /** Current time in epoch milliseconds; defaults to `Date.now`. */
  now?: () => number;
}

class UlidGenerator implements IdentifierGenerator {
  readonly #factory: ULIDFactory;
  readonly #now: () => number;

  constructor(deps: UlidDeps) {
    this.#factory = monotonicFactory(deps.prng);
    this.#now = deps.now ?? Date.now;
  }

  generate(): string {
    return this.#factory(this.#now());
  }

  isValid(id: string): boolean {
    return id.length === ULID_LENGTH && ULID_PATTERN.test(id);
  }
}

/**
 * Builds a ulid-backed sortable {@link IdentifierGenerator}. IDs are monotonic and
 * lexicographically time-ordered, preserving the k-sortable property of the Go `rs/xid` IDs.
 */
export function ulidGenerator(deps: UlidDeps = {}): IdentifierGenerator {
  return new UlidGenerator(deps);
}
