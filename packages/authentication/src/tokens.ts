/**
 * The token-generation contract. Produces URL-safe (base64url) random strings suitable for
 * password-reset links, API keys, and session identifiers.
 */
export interface TokenGenerator {
  /** Returns a base64url-encoded random token from `byteLength` bytes of entropy (default 32). */
  generate(byteLength?: number): string;
}
