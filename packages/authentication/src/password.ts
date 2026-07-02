/**
 * The password-hashing contract. Implementations encode every parameter needed to verify a
 * password into the returned string, so {@link verify} is self-describing and a stored hash
 * stays verifiable even after defaults change. A wrong password is `false`, not an error.
 */
export interface PasswordHasher {
  /** Hashes a plaintext password into a self-describing encoded string. */
  hash(password: string): Promise<string>;
  /**
   * Reports whether `password` matches the given encoded hash. Returns `false` — never
   * throws — on a wrong password or a malformed encoded string.
   */
  verify(password: string, encoded: string): Promise<boolean>;
}
