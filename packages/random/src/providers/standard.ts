import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import { bytesToBase32, bytesToBase64Url, bytesToHex } from "../encoding.js";
import type { RandomGenerator } from "../random.js";

const o11yName = "random";

/** WebCrypto's per-call ceiling for `getRandomValues`, in bytes. Larger fills are chunked. */
const MAX_BYTES_PER_CALL = 65536;

/**
 * The default {@link RandomGenerator}: cryptographically secure bytes drawn from
 * `globalThis.crypto.getRandomValues`, which exists on Node 20+ and in browsers. Fills larger
 * than WebCrypto's 64 KiB per-call ceiling are chunked transparently, so an arbitrary length
 * never trips the quota.
 */
export class StandardGenerator implements RandomGenerator {
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(deps: ObservabilityDeps = {}) {
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  generateRawBytes(length: number): Uint8Array {
    return this.#secureBytes(length);
  }

  generateHexEncodedString(length: number): string {
    return bytesToHex(this.#secureBytes(length));
  }

  generateBase32EncodedString(length: number): string {
    return bytesToBase32(this.#secureBytes(length));
  }

  generateBase64EncodedString(length: number): string {
    return bytesToBase64Url(this.#secureBytes(length));
  }

  #secureBytes(length: number): Uint8Array {
    if (!Number.isInteger(length) || length < 0) {
      throw new RangeError(
        `random byte length must be a non-negative integer, got ${String(length)}`,
      );
    }
    const out = new Uint8Array(length);
    try {
      for (let offset = 0; offset < length; offset += MAX_BYTES_PER_CALL) {
        const end = Math.min(offset + MAX_BYTES_PER_CALL, length);
        globalThis.crypto.getRandomValues(out.subarray(offset, end));
      }
    } catch (err) {
      this.#logger.error("reading from secure random source", err);
      throw err;
    }
    return out;
  }
}
