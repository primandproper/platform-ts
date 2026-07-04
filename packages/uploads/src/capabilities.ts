import type { UploadManager } from "./uploads.js";

/**
 * Optional capabilities beyond the core {@link UploadManager}. The core guarantees only
 * save/open/delete/exists; richer backends (the object-store {@link Uploader}, the noop manager)
 * also implement these. Callers that need one either accept the specific interface or narrow an
 * `UploadManager` with the `is*` guards below — the TypeScript analogue of Go's type assertions.
 */

/**
 * Opens a byte range of an object — for partial reads such as HTTP Range requests (video) or
 * seeking within columnar files (parquet).
 */
export interface RangeReader {
  /**
   * Returns a stream over `length` bytes of the object at `path`, starting at `offset`. A
   * negative `length` reads to the end of the object.
   */
  openRange(
    path: string,
    offset: number,
    length: number,
  ): Promise<ReadableStream<Uint8Array>>;
}

/**
 * Mints a signed URL granting temporary, direct access to an object, letting clients read or
 * write storage without proxying bytes through the service.
 */
export interface URLSigner {
  signedURL(path: string, opts?: SignedURLOptions): Promise<string>;
}

/** Fetches an object's stored metadata. */
export interface Attributer {
  attributes(path: string): Promise<Attributes>;
}

/**
 * Streams the objects stored under a prefix. The returned iterator yields each object lazily; a
 * failure throws mid-iteration, and the caller may stop early by breaking out of the loop.
 */
export interface Lister {
  list(prefix: string): AsyncIterable<ObjectInfo>;
}

/** Configures a signed URL — the port of Go's `SignedURLOptions`. */
export interface SignedURLOptions {
  /** The HTTP method the URL permits. Defaults to `"GET"`. */
  method?: "GET" | "PUT" | "DELETE";
  /** For PUT URLs, the exact `Content-Type` the client must send. */
  contentType?: string;
  /** How long the URL is valid, in milliseconds. Omitted/zero means the provider default. */
  expiry?: number;
}

/** Describes a stored object — the port of Go's `Attributes`. */
export interface Attributes {
  /** Last-modified time, when the provider reports one. */
  modTime?: Date;
  contentType?: string;
  cacheControl?: string;
  etag?: string;
  /** Size in bytes. */
  size: number;
}

/** A single entry returned by {@link Lister.list} — the port of Go's `ObjectInfo`. */
export interface ObjectInfo {
  /** Last-modified time, when the provider reports one. */
  modTime?: Date;
  path: string;
  size: number;
  isDir: boolean;
}

/**
 * Drains a {@link Lister} into an array — the port of Go's `uploads.ListAll`. A convenience for
 * small listings; prefer iterating {@link Lister.list} directly when a prefix may hold very many
 * objects.
 */
export async function listAll(l: Lister, prefix: string): Promise<ObjectInfo[]> {
  const out: ObjectInfo[] = [];
  for await (const obj of l.list(prefix)) {
    out.push(obj);
  }
  return out;
}

/** Narrows a manager to a {@link RangeReader}. */
export function isRangeReader(m: UploadManager): m is UploadManager & RangeReader {
  return typeof (m as Partial<RangeReader>).openRange === "function";
}

/** Narrows a manager to a {@link URLSigner}. */
export function isURLSigner(m: UploadManager): m is UploadManager & URLSigner {
  return typeof (m as Partial<URLSigner>).signedURL === "function";
}

/** Narrows a manager to an {@link Attributer}. */
export function isAttributer(m: UploadManager): m is UploadManager & Attributer {
  return typeof (m as Partial<Attributer>).attributes === "function";
}

/** Narrows a manager to a {@link Lister}. */
export function isLister(m: UploadManager): m is UploadManager & Lister {
  return typeof (m as Partial<Lister>).list === "function";
}
