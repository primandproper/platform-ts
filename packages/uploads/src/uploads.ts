import { collectStream, type BlobBody } from "./stream.js";

/**
 * Reads and writes objects in a storage provider — the faithful port of platform-go's
 * `uploads.UploadManager`.
 *
 * The core surface is deliberately small: `save`/`open`/`delete`/`exists`. Richer backends also
 * implement the optional capability interfaces in `capabilities.ts` (ranged reads, signed URLs,
 * attributes, listing); callers reach for those by type-narrowing a manager (see `isLister` &c.).
 *
 * `open` rejects when a path is absent — a missing object is genuinely exceptional here, unlike
 * the cache/secrets miss-as-`undefined` convention. Providers reject with {@link BlobNotFoundError}.
 */
export interface UploadManager {
  /**
   * Writes `body` to the object at `path`, replacing any existing object. `body` may be a byte
   * slice or a {@link ReadableStream} for content that shouldn't be buffered in memory.
   */
  save(path: string, body: BlobBody, opts?: SaveOptions): Promise<void>;
  /** Returns a byte stream for the object at `path`. Rejects when `path` is absent. */
  open(path: string): Promise<ReadableStream<Uint8Array>>;
  /** Removes the object at `path`. */
  delete(path: string): Promise<void>;
  /** Reports whether an object exists at `path`. */
  exists(path: string): Promise<boolean>;
}

/**
 * Resolved settings for a {@link UploadManager.save} call — the port of Go's `SaveOptions`
 * (its functional `WithContentType`/`WithCacheControl` options collapse to this plain object in
 * idiomatic TypeScript).
 */
export interface SaveOptions {
  /**
   * The stored `Content-Type`. When omitted, providers that can sniff (e.g. object stores)
   * infer it from the content on write; others store the object untyped.
   */
  contentType?: string;
  /** The stored `Cache-Control` header for served objects. */
  cacheControl?: string;
}

/**
 * Saves a byte slice via {@link UploadManager.save} — the port of Go's `uploads.SaveFile`
 * convenience helper.
 */
export function saveFile(
  m: UploadManager,
  path: string,
  content: Uint8Array,
  opts?: SaveOptions,
): Promise<void> {
  return m.save(path, content, opts);
}

/**
 * Reads an entire object into memory via {@link UploadManager.open} — the port of Go's
 * `uploads.ReadFile`. Rejects when the object is absent.
 */
export async function readFile(m: UploadManager, path: string): Promise<Uint8Array> {
  return collectStream(await m.open(path));
}
