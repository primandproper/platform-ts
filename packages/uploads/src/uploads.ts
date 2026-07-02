/** A stored blob: its bytes plus an optional MIME type. */
export interface Blob {
  body: Uint8Array;
  contentType?: string;
}

/** Per-object options accepted by {@link BlobStore.put}. */
export interface PutOptions {
  contentType?: string;
}

/**
 * The blob-store contract. A missing key reads back as `undefined` rather than a sentinel
 * error — the same idiomatic-TypeScript divergence the cache and secrets make from Go's
 * `(value, error)`.
 */
export interface BlobStore {
  /** Stores `body` under `key`, replacing any existing object. */
  put(key: string, body: Uint8Array, opts?: PutOptions): Promise<void>;
  /** Returns the object stored under `key`, or `undefined` when it is absent. */
  get(key: string): Promise<Blob | undefined>;
  /** Removes the object stored under `key`. A no-op when the key is absent. */
  delete(key: string): Promise<void>;
  /** Reports whether an object is stored under `key`. */
  exists(key: string): Promise<boolean>;
  /** Verifies the backing store is reachable. */
  ping(): Promise<void>;
}
