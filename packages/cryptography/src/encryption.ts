/**
 * The universal encryption contract. Symmetric, byte-in/byte-out, and intentionally
 * format-opaque: the shape of the ciphertext (IV placement, tag) is the provider's concern,
 * so call-site code never has to reason about it.
 */
export interface Encryptor {
  /**
   * Whether this provider authenticates its ciphertext. When `true`, {@link decrypt} detects and
   * rejects tampering (AES-GCM); when `false`, the cipher offers confidentiality only and
   * tampering is **undetectable** (raw Salsa20, passthrough). Inspect this before relying on
   * ciphertext integrity — the guarantee is not uniform across providers.
   */
  readonly authenticated: boolean;
  /** Encrypts plaintext, returning provider-framed ciphertext (IV + tag included). */
  encrypt(plaintext: Uint8Array): Promise<Uint8Array>;
  /**
   * Reverses {@link encrypt}. Rejects if the ciphertext is malformed. Rejects on tampering
   * **only when {@link authenticated} is `true`** — an unauthenticated provider cannot detect a
   * modified ciphertext and will return garbage plaintext successfully.
   */
  decrypt(ciphertext: Uint8Array): Promise<Uint8Array>;
}
