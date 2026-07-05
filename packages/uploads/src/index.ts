import type { ObservabilityDeps } from "@primandproper/observability";

import { PrefixedBucket, type Bucket } from "./bucket.js";
import {
  UploadsConfigSchema,
  type UploadsConfig,
  type UploadsConfigInput,
} from "./config.js";
import { FilesystemBucket } from "./providers/filesystem.js";
import { GCSBucket } from "./providers/gcp.js";
import { MemoryBucket } from "./providers/memory.js";
import { newBackblazeBucket, newR2Bucket, newS3Bucket } from "./providers/s3.js";
import { Uploader } from "./uploader.js";
import type { UploadManager } from "./uploads.js";

export * from "./uploads.js";
export * from "./capabilities.js";
export * from "./config.js";
export {
  PrefixedBucket,
  BlobNotFoundError,
  SigningUnsupportedError,
  type Bucket,
} from "./bucket.js";
export { type BlobBody } from "./stream.js";
export {
  Uploader,
  newCircuitBrokenError,
  CIRCUIT_BROKEN_CODE,
  newFileTooLargeError,
  FILE_TOO_LARGE_CODE,
} from "./uploader.js";
export { MemoryBucket } from "./providers/memory.js";
export { FilesystemBucket } from "./providers/filesystem.js";
export { GCSBucket } from "./providers/gcp.js";
export {
  S3Bucket,
  newS3Bucket,
  newR2Bucket,
  newBackblazeBucket,
} from "./providers/s3.js";
export { NoopUploadManager } from "./providers/noop.js";

/** Narrows a per-provider sub-config the schema's `superRefine` has already guaranteed present. */
function required<T>(value: T | undefined, provider: string): T {
  if (value === undefined) {
    throw new Error(`${provider} config is required when provider is '${provider}'`);
  }
  return value;
}

/** Opens the raw {@link Bucket} for the configured provider, before prefixing/instrumentation. */
function selectBucket(cfg: UploadsConfig): Bucket {
  switch (cfg.provider) {
    case "memory":
      return new MemoryBucket();
    case "filesystem":
      return new FilesystemBucket(required(cfg.filesystem, "filesystem").rootDirectory);
    case "s3":
      return newS3Bucket(cfg.bucketName);
    case "gcp":
      return new GCSBucket(cfg.bucketName);
    case "r2":
      return newR2Bucket(required(cfg.r2, "r2"), cfg.bucketName);
    case "backblaze_b2":
      return newBackblazeBucket(
        required(cfg.backblazeB2, "backblaze_b2"),
        cfg.bucketName,
      );
  }
}

/**
 * Validates config and returns an instrumented {@link UploadManager} — the port of Go's
 * `objectstorage.NewUploadManager` + `ProvideUploadManager`. Opens the provider's {@link Bucket},
 * wraps it in a {@link PrefixedBucket} when `bucketPrefix` is set, and hands it to an
 * {@link Uploader}. Supports `memory` (default), `filesystem`, `s3`, `gcp`, `r2`, and `backblaze_b2`.
 *
 * The returned manager also implements the optional capabilities; narrow it with `isLister` &c.
 * to reach them. For a no-op manager, construct {@link NoopUploadManager} directly.
 */
export function provideUploads(
  config?: UploadsConfigInput,
  deps?: ObservabilityDeps,
): UploadManager {
  const cfg = UploadsConfigSchema.parse(config ?? {});
  const raw = selectBucket(cfg);
  const bucket = cfg.bucketPrefix ? new PrefixedBucket(raw, cfg.bucketPrefix) : raw;
  return new Uploader(cfg, bucket, deps);
}
