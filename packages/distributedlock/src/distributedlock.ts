/**
 * A held distributed lock. Returned by {@link DistributedLock.acquire} on a successful
 * acquisition; release it when done, or refresh it to extend the lease before it expires.
 */
export interface Lock {
  /** The key this lock guards. */
  readonly key: string;
  /**
   * Releases the lock, freeing the lease only if this caller still owns it. Resolves `true` when
   * it freed an owned lease, `false` when the lease had already expired or been taken over by
   * another holder — a lost lease is reported, not silently swallowed, so a caller can tell it
   * was doing "exclusive" work it no longer had the right to.
   */
  release(): Promise<boolean>;
  /**
   * Extends the lease, resetting its expiry to `ttlMs` from now (or the lock's original ttl
   * when omitted). Resolves `true` when the still-owned lease was extended, `false` when the
   * lease had expired or been taken over — a refresh loop should treat `false` as "lease lost,
   * stop the exclusive work".
   */
  refresh(ttlMs?: number): Promise<boolean>;
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
  /**
   * Releases any resources the lock manager holds (e.g. a Redis connection) so the process can
   * exit gracefully. Providers that hold nothing resolve immediately; the postgres provider leaves
   * its injected pool open for its owner. Idempotent — safe to call more than once. Held
   * {@link Lock}s are not released by this; release or let them expire before closing.
   */
  close(): Promise<void>;
}
