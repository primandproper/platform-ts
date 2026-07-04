import { BlobNotFoundError, SigningUnsupportedError, type Bucket } from "../bucket.js";
import type { Attributes, ObjectInfo } from "../capabilities.js";
import { bytesToStream, toBytes, type BlobBody } from "../stream.js";
import type { SaveOptions } from "../uploads.js";

interface StoredBlob {
  content: Uint8Array;
  contentType: string | undefined;
  cacheControl: string | undefined;
  modTime: Date;
}

/**
 * A {@link Bucket} backed by an in-process `Map` — the port of gocloud's `memblob`, and the
 * default provider. Signing is unsupported, exactly as with `memblob`.
 */
export class MemoryBucket implements Bucket {
  readonly #blobs = new Map<string, StoredBlob>();

  async write(key: string, body: BlobBody, opts?: SaveOptions): Promise<void> {
    const content = (await toBytes(body)).slice();
    this.#blobs.set(key, {
      content,
      contentType: opts?.contentType,
      cacheControl: opts?.cacheControl,
      modTime: new Date(),
    });
  }

  openRange(
    key: string,
    offset: number,
    length: number,
  ): Promise<ReadableStream<Uint8Array>> {
    const stored = this.#blobs.get(key);
    if (stored === undefined) {
      return Promise.reject(new BlobNotFoundError(key));
    }
    const end = length < 0 ? stored.content.length : offset + length;
    return Promise.resolve(bytesToStream(stored.content.slice(offset, end)));
  }

  delete(key: string): Promise<void> {
    this.#blobs.delete(key);
    return Promise.resolve();
  }

  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.#blobs.has(key));
  }

  attributes(key: string): Promise<Attributes> {
    const stored = this.#blobs.get(key);
    if (stored === undefined) {
      return Promise.reject(new BlobNotFoundError(key));
    }
    return Promise.resolve({
      size: stored.content.length,
      modTime: stored.modTime,
      ...(stored.contentType !== undefined && { contentType: stored.contentType }),
      ...(stored.cacheControl !== undefined && { cacheControl: stored.cacheControl }),
    });
  }

  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    for (const [key, stored] of this.#blobs) {
      if (key.startsWith(prefix)) {
        yield {
          path: key,
          size: stored.content.length,
          modTime: stored.modTime,
          isDir: false,
        };
      }
    }
  }

  signedURL(): Promise<string> {
    return Promise.reject(new SigningUnsupportedError("memory"));
  }
}
