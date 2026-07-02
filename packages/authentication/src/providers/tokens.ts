import { randomBytes } from "node:crypto";

import type { TokenGenerator } from "../tokens.js";

export interface RandomTokenGeneratorOptions {
  /** Default entropy in bytes used when {@link RandomTokenGenerator.generate} is called bare. */
  byteLength?: number;
}

/** Generates base64url tokens from cryptographically secure random bytes. */
export class RandomTokenGenerator implements TokenGenerator {
  readonly #byteLength: number;

  constructor(options: RandomTokenGeneratorOptions = {}) {
    this.#byteLength = options.byteLength ?? 32;
  }

  generate(byteLength: number = this.#byteLength): string {
    return randomBytes(byteLength).toString("base64url");
  }
}
