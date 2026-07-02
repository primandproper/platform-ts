/** The hash algorithms with parity across Node 20+ and browser `crypto.subtle`. */
export type HashAlgorithm = "SHA-256" | "SHA-384" | "SHA-512";

/**
 * The universal hashing contract. A {@link Hasher} computes a fixed digest over arbitrary
 * bytes and can constant-time-verify a candidate digest against fresh input.
 */
export interface Hasher {
  /** The algorithm this hasher computes, exposed for callers that store it alongside data. */
  readonly algorithm: HashAlgorithm;
  /** Computes the digest of `data`. */
  hash(data: Uint8Array): Promise<Uint8Array>;
  /** Returns true iff `data` hashes to `digest`. Compared in constant time. */
  verify(data: Uint8Array, digest: Uint8Array): Promise<boolean>;
}
