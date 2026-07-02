import { customAlphabet, customRandom } from "nanoid";

import type { IdentifierConfig } from "./config.js";
import type { IdentifierGenerator } from "./generator.js";

/** Fills `bytes` with random values; the seam nanoid's `customRandom` uses. Overridable in tests. */
export type RandomBytes = (bytes: number) => Uint8Array;

/** Injectable randomness for the nanoid generator. */
export interface NanoidDeps {
  randomBytes?: RandomBytes;
}

class NanoidGenerator implements IdentifierGenerator {
  readonly #generate: () => string;
  readonly #size: number;
  readonly #allowed: ReadonlySet<string>;

  constructor(config: Pick<IdentifierConfig, "alphabet" | "size">, deps: NanoidDeps) {
    this.#size = config.size;
    this.#allowed = new Set(config.alphabet);
    this.#generate = deps.randomBytes
      ? customRandom(config.alphabet, config.size, deps.randomBytes)
      : customAlphabet(config.alphabet, config.size);
  }

  generate(): string {
    return this.#generate();
  }

  isValid(id: string): boolean {
    if (id.length !== this.#size) {
      return false;
    }
    for (const char of id) {
      if (!this.#allowed.has(char)) {
        return false;
      }
    }
    return true;
  }
}

/** Builds a nanoid-backed random {@link IdentifierGenerator} (default URL-safe scheme). */
export function nanoidGenerator(
  config: Pick<IdentifierConfig, "alphabet" | "size">,
  deps: NanoidDeps = {},
): IdentifierGenerator {
  return new NanoidGenerator(config, deps);
}
