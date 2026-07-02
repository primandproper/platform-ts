/**
 * The TOTP contract (RFC 6238). Secrets are base32 (RFC 4648, no padding) so they round-trip
 * through authenticator apps via {@link keyUri}. `atMs` pins the clock for deterministic tests.
 */
export interface TOTP {
  /** Returns a fresh base32-encoded secret of the given byte length (default 20). */
  generateSecret(bytes?: number): string;
  /** Builds the `otpauth://totp/...` URI an authenticator app scans to enroll the secret. */
  keyUri(secret: string, accountName: string, issuer: string): string;
  /** Returns the current code for the secret, or the code at `atMs` when pinned. */
  generate(secret: string, atMs?: number): string;
  /**
   * Reports whether `code` is valid for the secret within `±window` time steps (default 1),
   * optionally at the pinned time `atMs`. Compared in constant time.
   */
  verify(
    secret: string,
    code: string,
    opts?: { window?: number; atMs?: number },
  ): boolean;
}
