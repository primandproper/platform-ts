import { salsa20 } from "@noble/ciphers/salsa.js";
import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import { base64ToBytes } from "../base64.js";
import type { Encryptor } from "../encryption.js";

const o11yName = "cryptography";

/** Salsa20 nonce length in bytes, matching platform-go's `nonceSize`. */
const NONCE_BYTES = 8;

/** Salsa20 requires a 256-bit key. */
const KEY_BYTES = 32;

export interface Salsa20EncryptorOptions {
  /** Base64-encoded raw 256-bit (32-byte) key. */
  key: string;
}

/**
 * Universal Salsa20 {@link Encryptor}, ported from platform-go's `salsa20` provider. A fresh
 * random 8-byte nonce is generated per message and prepended to the ciphertext, so `decrypt` is
 * self-describing. Built on the audited `@noble/ciphers` (isomorphic, no Node built-ins).
 *
 * SECURITY: Salsa20 is a raw stream cipher — unlike {@link AesGcmEncryptor} it is NOT
 * authenticated, so tampering is undetectable and a nonce must never repeat under a given key.
 * Prefer AES-GCM unless you specifically need Salsa20 for interop with the Go platform.
 */
export class Salsa20Encryptor implements Encryptor {
  readonly #key: Uint8Array;
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(options: Salsa20EncryptorOptions, deps: ObservabilityDeps = {}) {
    this.#key = base64ToBytes(options.key);
    if (this.#key.byteLength !== KEY_BYTES) {
      throw new Error(
        `invalid Salsa20 key length: ${String(this.#key.byteLength)} bytes (expected 32)`,
      );
    }
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const ciphertext = salsa20(this.#key, nonce, plaintext);
    const framed = new Uint8Array(nonce.byteLength + ciphertext.byteLength);
    framed.set(nonce, 0);
    framed.set(ciphertext, nonce.byteLength);
    return framed;
  }

  async decrypt(ciphertext: Uint8Array): Promise<Uint8Array> {
    if (ciphertext.byteLength < NONCE_BYTES) {
      this.#logger.debug("Salsa20 decrypt: ciphertext too short for nonce");
      throw new Error("ciphertext too short: missing nonce");
    }
    const nonce = ciphertext.subarray(0, NONCE_BYTES);
    const body = ciphertext.subarray(NONCE_BYTES);
    return salsa20(this.#key, nonce, body);
  }
}
