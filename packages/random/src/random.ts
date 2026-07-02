/**
 * Generates cryptographically secure random values, encoded for transport. The TypeScript
 * analogue of platform-go's `random.Generator`. Backed by WebCrypto's `getRandomValues`, the
 * same interface holds on Node 20+ and in browsers, so call-site code is portable across
 * environments. `length` is the number of random bytes drawn, before encoding.
 */
export interface RandomGenerator {
  /** Returns `length` cryptographically secure random bytes. */
  generateRawBytes(length: number): Uint8Array;
  /** Returns `length` random bytes as a lowercase hex string. */
  generateHexEncodedString(length: number): string;
  /** Returns `length` random bytes as a standard (padded) RFC 4648 base32 string. */
  generateBase32EncodedString(length: number): string;
  /** Returns `length` random bytes as a raw URL-safe base64 string (no padding). */
  generateBase64EncodedString(length: number): string;
}
