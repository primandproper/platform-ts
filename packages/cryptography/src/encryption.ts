/**
 * The universal encryption contract. Symmetric, byte-in/byte-out, and intentionally
 * format-opaque: the shape of the ciphertext (IV placement, tag) is the provider's concern,
 * so call-site code never has to reason about it.
 */
export interface Encryptor {
  /** Encrypts plaintext, returning provider-framed ciphertext (IV + tag included). */
  encrypt(plaintext: Uint8Array): Promise<Uint8Array>;
  /** Reverses {@link encrypt}; rejects if the ciphertext is malformed or tampered with. */
  decrypt(ciphertext: Uint8Array): Promise<Uint8Array>;
}
