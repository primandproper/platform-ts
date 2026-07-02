import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import { bufferSource } from "../bytes.js";
import type { HashAlgorithm, Hasher } from "../hashing.js";

const o11yName = "cryptography";

export interface SubtleHasherOptions {
  algorithm: HashAlgorithm;
}

/**
 * Universal {@link Hasher} over `globalThis.crypto.subtle.digest`. Only SHA-256/384/512 are
 * offered, the algorithms with parity across Node 20+ and browsers (no MD5/SHA-1, which the
 * Web Crypto digest API deliberately omits).
 */
export class SubtleHasher implements Hasher {
  readonly algorithm: HashAlgorithm;
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(options: SubtleHasherOptions, deps: ObservabilityDeps = {}) {
    this.algorithm = options.algorithm;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  async hash(data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(
      await globalThis.crypto.subtle.digest(this.algorithm, bufferSource(data)),
    );
  }

  async verify(data: Uint8Array, digest: Uint8Array): Promise<boolean> {
    const actual = await this.hash(data);
    if (actual.byteLength !== digest.byteLength) {
      this.#logger.debug("hash verify: digest length mismatch");
      return false;
    }
    let diff = 0;
    for (let i = 0; i < actual.byteLength; i += 1) {
      // Lengths were checked equal above; `?? 0` only satisfies the index type.
      diff |= (actual[i] ?? 0) ^ (digest[i] ?? 0);
    }
    return diff === 0;
  }
}
