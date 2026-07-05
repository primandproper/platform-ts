import type { Encryptor } from "../encryption.js";

/**
 * An identity {@link Encryptor} that returns its input unchanged. This provides NO
 * confidentiality and exists ONLY for tests and local wiring where real encryption is
 * undesirable. Never select it in production — it is the deliberate opposite of secure.
 */
export class PassthroughEncryptor implements Encryptor {
  /** Passthrough provides neither confidentiality nor integrity. */
  readonly authenticated = false;

  encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(plaintext);
  }

  decrypt(ciphertext: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(ciphertext);
  }
}
