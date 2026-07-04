import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { wrap } from "@primandproper/errors";

import { BlobNotFoundError, type Bucket } from "../bucket.js";
import type { Attributes, ObjectInfo, SignedURLOptions } from "../capabilities.js";
import type { BackblazeB2Config, R2Config } from "../config.js";
import { toBytes, type BlobBody } from "../stream.js";
import type { SaveOptions } from "../uploads.js";

/**
 * A {@link Bucket} backed by S3 or any S3-compatible service. The port of gocloud's `s3blob`,
 * and — as in platform-go, where R2 and Backblaze B2 also open through `s3blob` with a custom
 * endpoint — the single implementation behind the `s3`, `r2`, and `backblaze_b2` providers.
 *
 * Reads stream (so ranged reads never buffer a whole object), but a write drains its body first:
 * a single `PutObject` needs a known length, and pulling in `@aws-sdk/lib-storage` for multipart
 * streaming isn't worth it here. A missing object is normalized to {@link BlobNotFoundError};
 * every other SDK failure is rethrown wrapped with context.
 */
export class S3Bucket implements Bucket {
  readonly #client: S3Client;
  readonly #bucket: string;

  constructor(client: S3Client, bucketName: string) {
    this.#client = client;
    this.#bucket = bucketName;
  }

  async write(key: string, body: BlobBody, opts?: SaveOptions): Promise<void> {
    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Body: await toBytes(body),
          ContentType: opts?.contentType,
          CacheControl: opts?.cacheControl,
        }),
      );
    } catch (err) {
      throw wrap(`s3 write failed for key '${key}'`, err);
    }
  }

  async openRange(
    key: string,
    offset: number,
    length: number,
  ): Promise<ReadableStream<Uint8Array>> {
    let response;
    try {
      response = await this.#client.send(
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Range: rangeHeader(offset, length),
        }),
      );
    } catch (err) {
      if (isNotFound(err)) {
        throw new BlobNotFoundError(key);
      }
      throw wrap(`s3 read failed for key '${key}'`, err);
    }

    if (response.Body === undefined) {
      throw new BlobNotFoundError(key);
    }
    return response.Body.transformToWebStream();
  }

  async delete(key: string): Promise<void> {
    try {
      await this.#client.send(
        new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
    } catch (err) {
      throw wrap(`s3 delete failed for key '${key}'`, err);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key }));
      return true;
    } catch (err) {
      if (isNotFound(err)) {
        return false;
      }
      throw wrap(`s3 exists check failed for key '${key}'`, err);
    }
  }

  async attributes(key: string): Promise<Attributes> {
    let head;
    try {
      head = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
    } catch (err) {
      if (isNotFound(err)) {
        throw new BlobNotFoundError(key);
      }
      throw wrap(`s3 attributes fetch failed for key '${key}'`, err);
    }
    return {
      size: head.ContentLength ?? 0,
      ...(head.ContentType !== undefined && { contentType: head.ContentType }),
      ...(head.CacheControl !== undefined && { cacheControl: head.CacheControl }),
      ...(head.ETag !== undefined && { etag: head.ETag }),
      ...(head.LastModified !== undefined && { modTime: head.LastModified }),
    };
  }

  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    let continuationToken: string | undefined;
    do {
      let page;
      try {
        page = await this.#client.send(
          new ListObjectsV2Command({
            Bucket: this.#bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );
      } catch (err) {
        throw wrap(`s3 list failed for prefix '${prefix}'`, err);
      }
      for (const obj of page.Contents ?? []) {
        if (obj.Key === undefined) {
          continue;
        }
        yield {
          path: obj.Key,
          size: obj.Size ?? 0,
          isDir: false,
          ...(obj.LastModified !== undefined && { modTime: obj.LastModified }),
        };
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);
  }

  async signedURL(key: string, opts?: SignedURLOptions): Promise<string> {
    const method = opts?.method ?? "GET";
    const command =
      method === "PUT"
        ? new PutObjectCommand({
            Bucket: this.#bucket,
            Key: key,
            ContentType: opts?.contentType,
          })
        : method === "DELETE"
          ? new DeleteObjectCommand({ Bucket: this.#bucket, Key: key })
          : new GetObjectCommand({ Bucket: this.#bucket, Key: key });

    const expiresIn =
      opts?.expiry !== undefined && opts.expiry > 0
        ? Math.ceil(opts.expiry / 1000)
        : undefined;
    try {
      return await getSignedUrl(
        this.#client,
        command,
        expiresIn !== undefined ? { expiresIn } : {},
      );
    } catch (err) {
      throw wrap(`s3 signing failed for key '${key}'`, err);
    }
  }
}

/** Opens a plain S3 bucket, letting the SDK resolve region/credentials from its default chain. */
export function newS3Bucket(bucketName: string): S3Bucket {
  return new S3Bucket(new S3Client({}), bucketName);
}

/** Opens a Cloudflare R2 bucket via its account-scoped S3 endpoint with static credentials. */
export function newR2Bucket(cfg: R2Config, bucketName: string): S3Bucket {
  const config: S3ClientConfig = {
    endpoint: `https://${cfg.accountID}.r2.cloudflarestorage.com`,
    region: "auto",
    credentials: {
      accessKeyId: cfg.accessKeyID,
      secretAccessKey: cfg.secretAccessKey,
    },
  };
  return new S3Bucket(new S3Client(config), bucketName);
}

/** Opens a Backblaze B2 bucket via its region-scoped S3 endpoint with an application key. */
export function newBackblazeBucket(cfg: BackblazeB2Config, bucketName: string): S3Bucket {
  const config: S3ClientConfig = {
    endpoint: `https://s3.${cfg.region}.backblazeb2.com`,
    region: cfg.region,
    credentials: {
      accessKeyId: cfg.applicationKeyID,
      secretAccessKey: cfg.applicationKey,
    },
  };
  return new S3Bucket(new S3Client(config), bucketName);
}

/** Builds an HTTP Range header, or `undefined` for a full read (offset 0, negative length). */
function rangeHeader(offset: number, length: number): string | undefined {
  if (offset === 0 && length < 0) {
    return undefined;
  }
  const start = String(offset);
  return length < 0 ? `bytes=${start}-` : `bytes=${start}-${String(offset + length - 1)}`;
}

/** True when the SDK error signals an absent object (404 / NoSuchKey / NotFound). */
function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const name = (err as { name?: unknown }).name;
  const status = (err as { $metadata?: { httpStatusCode?: unknown } }).$metadata
    ?.httpStatusCode;
  return name === "NoSuchKey" || name === "NotFound" || status === 404;
}
