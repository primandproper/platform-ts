/**
 * A held distributed lock. Returned by {@link DistributedLock.acquire} on a successful
 * acquisition; release it when done, or refresh it to extend the lease before it expires.
 */
export interface Lock {
  /** The key this lock guards. */
  readonly key: string;
  /**
   * Releases the lock. A no-op if the lease has already expired or been taken over by
   * another holder — releasing only frees a lease this caller still owns.
   */
  release(): Promise<void>;
  /**
   * Extends the lease, resetting its expiry to `ttlMs` from now (or the lock's original ttl
   * when omitted). A no-op if the lease has expired or been taken over.
   */
  refresh(ttlMs?: number): Promise<void>;
}

/** Options for a single {@link DistributedLock.acquire} call. */
export interface AcquireOptions {
  /** How long the lease is held before it auto-expires, in milliseconds. */
  ttlMs?: number;
}

/**
 * A distributed mutual-exclusion lock. Contention is `undefined`, not a sentinel error — the
 * same idiomatic-TypeScript divergence from Go's `(value, error)` the cache makes for a miss.
 * Callers branch on the optional rather than catching a "lock held" exception.
 */
export interface DistributedLock {
  /**
   * Attempts to acquire the lock for `key`. Returns a {@link Lock} on success, or `undefined`
   * when the key is currently held by someone else (do not retry-on-throw; branch on the
   * optional). Leases auto-expire after their ttl, so a stale holder never deadlocks the key.
   */
  acquire(key: string, opts?: AcquireOptions): Promise<Lock | undefined>;
  /** Verifies the backing store is reachable. */
  ping(): Promise<void>;
}
