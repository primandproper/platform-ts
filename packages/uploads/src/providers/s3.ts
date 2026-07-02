import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { wrap } from "@primandproper/errors";
import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type { Blob, BlobStore, PutOptions } from "../uploads.js";

const o11yName = "uploads";

export interface S3BlobStoreOptions {
  /** The bucket every object is stored under. */
  bucket: string;
  /** The AWS region. Required by the SDK; ignored when a custom `endpoint` is set. */
  region: string;
  /**
   * Overrides the S3 endpoint — point this at MinIO, LocalStack, or another
   * S3-compatible service. Defaults to AWS's regional endpoint.
   */
  endpoint?: string | undefined;
  /**
   * Forces path-style addressing (`endpoint/bucket/key`) instead of virtual-hosted
   * (`bucket.endpoint/key`). Required by most non-AWS S3-compatible services.
   */
  forcePathStyle?: boolean | undefined;
  /** Static credentials. Omit to let the SDK resolve them from its default chain. */
  credentials?:
    | {
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken?: string | undefined;
      }
    | undefined;
  /** A preconstructed client, mainly for tests. Takes precedence over the other options. */
  client?: S3Client | undefined;
}

/**
 * A {@link BlobStore} backed by Amazon S3 (or any S3-compatible service via `endpoint`).
 * A missing object reads back as `undefined` rather than a sentinel error; every other
 * SDK failure is rethrown wrapped with context.
 */
export class S3BlobStore implements BlobStore {
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(options: S3BlobStoreOptions, deps: ObservabilityDeps = {}) {
    this.#bucket = options.bucket;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
    this.#client = options.client ?? new S3Client(toClientConfig(options));
  }

  async put(key: string, body: Uint8Array, opts: PutOptions = {}): Promise<void> {
    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Body: body,
          ContentType: opts.contentType,
        }),
      );
    } catch (error) {
      throw wrap(`s3 put failed for key '${key}'`, error);
    }
  }

  async get(key: string): Promise<Blob | undefined> {
    let response;
    try {
      response = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
    } catch (error) {
      if (isNotFound(error)) {
        this.#logger.debug("blob not found");
        return undefined;
      }
      throw wrap(`s3 get failed for key '${key}'`, error);
    }

    if (response.Body === undefined) {
      return undefined;
    }

    let body: Uint8Array;
    try {
      body = await response.Body.transformToByteArray();
    } catch (error) {
      throw wrap(`s3 get failed for key '${key}'`, error);
    }

    return response.ContentType === undefined
      ? { body }
      : { body, contentType: response.ContentType };
  }

  async delete(key: string): Promise<void> {
    try {
      await this.#client.send(
        new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
    } catch (error) {
      throw wrap(`s3 delete failed for key '${key}'`, error);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key }));
      return true;
    } catch (error) {
      if (isNotFound(error)) {
        return false;
      }
      throw wrap(`s3 exists failed for key '${key}'`, error);
    }
  }

  async ping(): Promise<void> {
    try {
      await this.#client.send(new HeadBucketCommand({ Bucket: this.#bucket }));
    } catch (error) {
      throw wrap(`s3 ping failed for key '${this.#bucket}'`, error);
    }
  }
}

/** Maps store options onto the S3 client constructor config, dropping undefined keys. */
function toClientConfig(options: S3BlobStoreOptions): S3ClientConfig {
  const config: S3ClientConfig = {
    region: options.region,
  };
  if (options.endpoint !== undefined) {
    config.endpoint = options.endpoint;
  }
  if (options.forcePathStyle !== undefined) {
    config.forcePathStyle = options.forcePathStyle;
  }
  if (options.credentials !== undefined) {
    const { accessKeyId, secretAccessKey, sessionToken } = options.credentials;
    config.credentials =
      sessionToken === undefined
        ? { accessKeyId, secretAccessKey }
        : { accessKeyId, secretAccessKey, sessionToken };
  }
  return config;
}

/** True when the SDK error signals an absent object (404 / NoSuchKey / NotFound). */
function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  const status = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata
    ?.httpStatusCode;
  return (
    name === "NoSuchKey" ||
    name === "NotFound" ||
    name === "NoSuchBucket" ||
    status === 404
  );
}
