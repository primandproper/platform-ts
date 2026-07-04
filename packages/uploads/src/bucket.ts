import { PlatformError } from "@primandproper/errors";

import type { Attributes, ObjectInfo, SignedURLOptions } from "./capabilities.js";
import type { BlobBody } from "./stream.js";
import type { SaveOptions } from "./uploads.js";

/**
 * The internal storage seam every provider implements — the analogue of the `*blob.Bucket` that
 * platform-go's `Uploader` wraps. Providers open different backends (memory, filesystem, S3, GCS)
 * behind this identical surface; {@link Uploader} layers the circuit breaker, metrics, and tracing
 * on top, exactly as the Go code layers them over gocloud's bucket.
 *
 * Not every backend supports every operation: the in-memory and unsigned filesystem buckets reject
 * {@link Bucket.signedURL} with {@link SigningUnsupportedError}, mirroring gocloud's `memblob` and
 * unsigned `fileblob`.
 */
export interface Bucket {
  /** Writes `body` to `key`, replacing any existing object. */
  write(key: string, body: BlobBody, opts?: SaveOptions): Promise<void>;
  /**
   * Returns a stream over `length` bytes of the object at `key`, starting at `offset`. A negative
   * `length` reads to the end. `openRange(key, 0, -1)` reads the whole object. Rejects with
   * {@link BlobNotFoundError} when `key` is absent.
   */
  openRange(
    key: string,
    offset: number,
    length: number,
  ): Promise<ReadableStream<Uint8Array>>;
  /** Removes the object at `key`. */
  delete(key: string): Promise<void>;
  /** Reports whether an object exists at `key`. */
  exists(key: string): Promise<boolean>;
  /** Fetches the stored metadata for `key`. Rejects with {@link BlobNotFoundError} when absent. */
  attributes(key: string): Promise<Attributes>;
  /** Streams the objects stored under `prefix`, lazily. */
  list(prefix: string): AsyncIterable<ObjectInfo>;
  /** Mints a signed URL for `key`, or rejects with {@link SigningUnsupportedError}. */
  signedURL(key: string, opts?: SignedURLOptions): Promise<string>;
}

/** Rejected by a bucket when a key is absent — the analogue of gocloud's `NotFound` code. */
export class BlobNotFoundError extends PlatformError {
  constructor(key: string) {
    super("uploads/not-found", `blob not found: ${key}`);
    this.name = "BlobNotFoundError";
  }
}

/** Rejected when a bucket cannot sign URLs (in-memory, unsigned filesystem). */
export class SigningUnsupportedError extends PlatformError {
  constructor(provider: string) {
    super(
      "uploads/signing-unsupported",
      `${provider} bucket does not support signed URLs`,
    );
    this.name = "SigningUnsupportedError";
  }
}

/**
 * Wraps a {@link Bucket} so every key is transparently prefixed — the port of Go's
 * `blob.PrefixedBucket`. Applied by the factory when `bucketPrefix` is set, so provider code never
 * has to know about it. Like Go, it strips the prefix back off keys returned by {@link Bucket.list}.
 */
export class PrefixedBucket implements Bucket {
  readonly #inner: Bucket;
  readonly #prefix: string;

  constructor(inner: Bucket, prefix: string) {
    this.#inner = inner;
    this.#prefix = prefix;
  }

  write(key: string, body: BlobBody, opts?: SaveOptions): Promise<void> {
    return this.#inner.write(this.#prefix + key, body, opts);
  }

  openRange(
    key: string,
    offset: number,
    length: number,
  ): Promise<ReadableStream<Uint8Array>> {
    return this.#inner.openRange(this.#prefix + key, offset, length);
  }

  delete(key: string): Promise<void> {
    return this.#inner.delete(this.#prefix + key);
  }

  exists(key: string): Promise<boolean> {
    return this.#inner.exists(this.#prefix + key);
  }

  attributes(key: string): Promise<Attributes> {
    return this.#inner.attributes(this.#prefix + key);
  }

  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    for await (const obj of this.#inner.list(this.#prefix + prefix)) {
      yield obj.path.startsWith(this.#prefix)
        ? { ...obj, path: obj.path.slice(this.#prefix.length) }
        : obj;
    }
  }

  signedURL(key: string, opts?: SignedURLOptions): Promise<string> {
    return this.#inner.signedURL(this.#prefix + key, opts);
  }
}
