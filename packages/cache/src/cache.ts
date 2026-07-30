/**
 * Per-write overrides. An options bag rather than a positional argument because it is the
 * extension point that will keep being asked for (`ifNotExists`, tags), and widening an object
 * is not a breaking change.
 */
export interface CacheSetOptions {
  /**
   * Overrides the cache's configured expiry for this entry, in milliseconds.
   *
   * Omitted, `0`, or negative all mean **"ignore this, keep the provider's configured expiry"** —
   * matching the Go platform's `WithExpiry` option setters. There is deliberately no per-entry way
   * to say "never expire": a cache configured with an expiry is expected to honour it, and a
   * caller that wants an immortal entry configures the cache without one. Stating the rule here is
   * the point — providers would otherwise disagree, since "no expiry" is equally defensible.
   */
  ttlMs?: number;
}

/**
 * The universal cache contract. A miss is represented by `undefined` rather than a sentinel
 * error — the idiomatic-TypeScript divergence from the Go platform's `cache.ErrNotFound`.
 */
export interface Cache<T> {
  /** Returns the cached value, or `undefined` on a miss. */
  get(key: string): Promise<T | undefined>;
  /**
   * Writes a value, optionally with a lifetime of its own. Two entries written through the same
   * cache instance may carry different TTLs — a short-lived claim and a long-lived result, say.
   * See {@link CacheSetOptions.ttlMs} for what an absent or non-positive TTL means.
   */
  set(key: string, value: T, opts?: CacheSetOptions): Promise<void>;
  delete(key: string): Promise<void>;
  /** Verifies the backing store is reachable. */
  ping(): Promise<void>;
  /**
   * Releases any resources the cache holds (e.g. a Redis connection) so the process can exit
   * gracefully. Providers that hold nothing resolve immediately; providers handed a shared client
   * leave it open for its owner. Idempotent — safe to call more than once.
   */
  close(): Promise<void>;
}

/**
 * A {@link Cache} that also supports batched reads and writes. Not every provider supports
 * batching, so obtain one via {@link isBatchCache}. Missing keys are omitted from the
 * returned map, so a key's absence is a cache miss.
 */
export interface BatchCache<T> extends Cache<T> {
  getMany(keys: string[]): Promise<Map<string, T>>;
  /**
   * Writes every item, applying one {@link CacheSetOptions.ttlMs} to the whole batch. Per-item
   * TTLs are not offered — a caller that needs them can issue separate `set` calls, and the batch
   * exists to save round trips, which mixed TTLs would not prevent but would complicate.
   */
  setMany(items: Map<string, T>, opts?: CacheSetOptions): Promise<void>;
}

/** Narrows a {@link Cache} to a {@link BatchCache} when the provider supports batching. */
export function isBatchCache<T>(cache: Cache<T>): cache is BatchCache<T> {
  const candidate = cache as Partial<BatchCache<T>>;
  return (
    typeof candidate.getMany === "function" && typeof candidate.setMany === "function"
  );
}
