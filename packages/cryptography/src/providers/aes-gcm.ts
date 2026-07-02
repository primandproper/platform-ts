import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import { base64ToBytes } from "../base64.js";
import { bufferSource } from "../bytes.js";
import type { Encryptor } from "../encryption.js";

const o11yName = "cryptography";

/** AES-GCM IV length in bytes (96 bits), the size NIST recommends for GCM. */
const IV_BYTES = 12;

/** Valid raw AES key lengths in bytes (128, 192, 256 bits). */
const VALID_KEY_BYTES = new Set([16, 24, 32]);

/**
 * Imports raw AES key bytes into a non-extractable {@link CryptoKey} for AES-GCM. Universal:
 * uses only `globalThis.crypto.subtle`, which exists in both Node 20+ and browsers.
 */
export async function importAesGcmKey(rawKey: Uint8Array): Promise<CryptoKey> {
  if (!VALID_KEY_BYTES.has(rawKey.byteLength)) {
    throw new Error(
      `invalid AES key length: ${String(rawKey.byteLength)} bytes (expected 16, 24, or 32)`,
    );
  }
  return globalThis.crypto.subtle.importKey(
    "raw",
    bufferSource(rawKey),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export interface AesGcmEncryptorOptions {
  /** Base64-encoded raw AES key (128/192/256-bit). */
  key: string;
}

/**
 * Universal AES-GCM {@link Encryptor}. A fresh random 96-bit IV is generated per message and
 * prepended to the ciphertext, so `decrypt` is self-describing. AES-GCM is authenticated, so
 * any tampering (including with the IV) surfaces as a decrypt rejection. Built on
 * `globalThis.crypto.subtle`, available on both Node 20+ and browsers.
 */
export class AesGcmEncryptor implements Encryptor {
  readonly #rawKey: Uint8Array;
  readonly #observer: Observer;
  readonly #logger: Logger;
  #key: Promise<CryptoKey> | undefined;

  constructor(options: AesGcmEncryptorOptions, deps: ObservabilityDeps = {}) {
    this.#rawKey = base64ToBytes(options.key);
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    const key = await this.#cryptoKey();
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = new Uint8Array(
      await globalThis.crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        bufferSource(plaintext),
      ),
    );
    const framed = new Uint8Array(iv.byteLength + ciphertext.byteLength);
    framed.set(iv, 0);
    framed.set(ciphertext, iv.byteLength);
    return framed;
  }

  async decrypt(ciphertext: Uint8Array): Promise<Uint8Array> {
    if (ciphertext.byteLength <= IV_BYTES) {
      throw new Error("ciphertext too short: missing IV or body");
    }
    const iv = ciphertext.subarray(0, IV_BYTES);
    const body = ciphertext.subarray(IV_BYTES);
    const key = await this.#cryptoKey();
    try {
      return new Uint8Array(
        await globalThis.crypto.subtle.decrypt(
          { name: "AES-GCM", iv: bufferSource(iv) },
          key,
          bufferSource(body),
        ),
      );
    } catch (err) {
      this.#logger.error("AES-GCM decryption failed (tampered or wrong key)", err);
      throw new Error("decryption failed: ciphertext is invalid or was tampered with");
    }
  }

  #cryptoKey(): Promise<CryptoKey> {
    this.#key ??= importAesGcmKey(this.#rawKey);
    return this.#key;
  }
}
