import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { Storage, type Bucket as GCSBucketHandle } from "@google-cloud/storage";
import { wrap } from "@primandproper/errors";

import { BlobNotFoundError, type Bucket } from "../bucket.js";
import type { Attributes, ObjectInfo, SignedURLOptions } from "../capabilities.js";
import { bytesToStream, type BlobBody } from "../stream.js";
import type { SaveOptions } from "../uploads.js";

/** HTTP status GCS returns for an absent object. */
const NOT_FOUND = 404;

/**
 * A {@link Bucket} backed by Google Cloud Storage — the port of gocloud's `gcsblob`. The client
 * resolves credentials from Application Default Credentials, matching Go's `gcp.DefaultCredentials`.
 * Both reads and writes stream: a write pipes the body into the GCS resumable upload stream rather
 * than buffering the whole payload in memory.
 */
export class GCSBucket implements Bucket {
  readonly #bucket: GCSBucketHandle;

  constructor(bucketName: string, storage: Storage = new Storage()) {
    this.#bucket = storage.bucket(bucketName);
  }

  async write(key: string, body: BlobBody, opts?: SaveOptions): Promise<void> {
    const writeStream = this.#bucket.file(key).createWriteStream({
      ...(opts?.contentType !== undefined && { contentType: opts.contentType }),
      ...(opts?.cacheControl !== undefined && {
        metadata: { cacheControl: opts.cacheControl },
      }),
    });
    const source = body instanceof Uint8Array ? bytesToStream(body) : body;
    try {
      await pipeline(Readable.fromWeb(source), writeStream);
    } catch (err) {
      throw wrap(`gcs write failed for key '${key}'`, err);
    }
  }

  async openRange(
    key: string,
    offset: number,
    length: number,
  ): Promise<ReadableStream<Uint8Array>> {
    // The GCS read stream errors lazily on a missing object; check up front so `open` rejects.
    if (!(await this.exists(key))) {
      throw new BlobNotFoundError(key);
    }
    const range =
      length < 0 ? { start: offset } : { start: offset, end: offset + length - 1 };
    const nodeStream = this.#bucket.file(key).createReadStream(range);
    return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  }

  async delete(key: string): Promise<void> {
    try {
      await this.#bucket.file(key).delete({ ignoreNotFound: true });
    } catch (err) {
      throw wrap(`gcs delete failed for key '${key}'`, err);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const [exists] = await this.#bucket.file(key).exists();
      return exists;
    } catch (err) {
      throw wrap(`gcs exists check failed for key '${key}'`, err);
    }
  }

  async attributes(key: string): Promise<Attributes> {
    let metadata;
    try {
      [metadata] = await this.#bucket.file(key).getMetadata();
    } catch (err) {
      if (isNotFound(err)) {
        throw new BlobNotFoundError(key);
      }
      throw wrap(`gcs attributes fetch failed for key '${key}'`, err);
    }
    return {
      size: metadata.size !== undefined ? Number(metadata.size) : 0,
      ...(metadata.contentType !== undefined && { contentType: metadata.contentType }),
      ...(metadata.cacheControl !== undefined && { cacheControl: metadata.cacheControl }),
      ...(metadata.etag !== undefined && { etag: metadata.etag }),
      ...(metadata.updated !== undefined && { modTime: new Date(metadata.updated) }),
    };
  }

  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    let pageToken: string | undefined;
    do {
      const query = pageToken !== undefined ? { prefix, pageToken } : { prefix };
      let response;
      try {
        response = await this.#bucket.getFiles(query);
      } catch (err) {
        throw wrap(`gcs list failed for prefix '${prefix}'`, err);
      }
      const [files, nextQuery] = response;
      for (const file of files) {
        const updated = file.metadata.updated;
        yield {
          path: file.name,
          size: file.metadata.size !== undefined ? Number(file.metadata.size) : 0,
          isDir: false,
          ...(updated !== undefined && { modTime: new Date(updated) }),
        };
      }
      pageToken = (nextQuery as { pageToken?: string } | null | undefined)?.pageToken;
    } while (pageToken !== undefined);
  }

  async signedURL(key: string, opts?: SignedURLOptions): Promise<string> {
    const action =
      opts?.method === "PUT" ? "write" : opts?.method === "DELETE" ? "delete" : "read";
    const expiry =
      opts?.expiry !== undefined && opts.expiry > 0 ? opts.expiry : 15 * 60 * 1000;
    try {
      const [url] = await this.#bucket.file(key).getSignedUrl({
        version: "v4",
        action,
        expires: Date.now() + expiry,
        ...(opts?.contentType !== undefined && { contentType: opts.contentType }),
      });
      return url;
    } catch (err) {
      throw wrap(`gcs signing failed for key '${key}'`, err);
    }
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === NOT_FOUND
  );
}
