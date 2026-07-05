/**
 * The universal cache contract. A miss is represented by `undefined` rather than a sentinel
 * error — the idiomatic-TypeScript divergence from the Go platform's `cache.ErrNotFound`.
 */
export interface Cache<T> {
  /** Returns the cached value, or `undefined` on a miss. */
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T): Promise<void>;
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
  setMany(items: Map<string, T>): Promise<void>;
}

/** Narrows a {@link Cache} to a {@link BatchCache} when the provider supports batching. */
export function isBatchCache<T>(cache: Cache<T>): cache is BatchCache<T> {
  const candidate = cache as Partial<BatchCache<T>>;
  return (
    typeof candidate.getMany === "function" && typeof candidate.setMany === "function"
  );
}
