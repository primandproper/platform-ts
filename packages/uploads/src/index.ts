import type { ObservabilityDeps } from "@primandproper/observability";

import { UploadsConfigSchema, type UploadsConfigInput } from "./config.js";
import { FilesystemBlobStore } from "./providers/filesystem.js";
import { MemoryBlobStore } from "./providers/memory.js";
import { NoopBlobStore } from "./providers/noop.js";
import { S3BlobStore } from "./providers/s3.js";
import type { BlobStore } from "./uploads.js";

export * from "./uploads.js";
export * from "./config.js";
export { MemoryBlobStore } from "./providers/memory.js";
export { FilesystemBlobStore } from "./providers/filesystem.js";
export { S3BlobStore, type S3BlobStoreOptions } from "./providers/s3.js";
export { NoopBlobStore } from "./providers/noop.js";

/**
 * Validates config and returns the matching {@link BlobStore}. Mirrors the Go platform's
 * `ProvideUploadManager`. Supports `memory` (default), `filesystem`, `s3`, and `noop`.
 */
export function provideUploads(
  config?: UploadsConfigInput,
  deps?: ObservabilityDeps,
): BlobStore {
  const cfg = UploadsConfigSchema.parse(config ?? {});
  switch (cfg.provider) {
    case "memory":
      return new MemoryBlobStore(deps);
    case "filesystem":
      // superRefine guarantees this, but narrow for the type checker.
      if (cfg.filesystem === undefined) {
        throw new Error("filesystem config is required when provider is 'filesystem'");
      }
      return new FilesystemBlobStore({ dir: cfg.filesystem.dir }, deps);
    case "s3":
      // superRefine guarantees this, but narrow for the type checker.
      if (cfg.s3 === undefined) {
        throw new Error("s3 config is required when provider is 's3'");
      }
      return new S3BlobStore(cfg.s3, deps);
    case "noop":
      return new NoopBlobStore();
  }
}
