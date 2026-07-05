import { CircuitBreakerConfigSchema } from "@primandproper/circuitbreaking";
import { z } from "zod";

/** Provider identifiers, mirroring Go's per-adapter provider constants. */
export const S3_PROVIDER = "s3";
export const FILESYSTEM_PROVIDER = "filesystem";
export const MEMORY_PROVIDER = "memory";
export const GCP_PROVIDER = "gcp";
export const R2_PROVIDER = "r2";
export const BACKBLAZE_B2_PROVIDER = "backblaze_b2";

/** Filesystem-provider config: blobs are written under `rootDirectory`. */
export const FilesystemConfigSchema = z.object({
  rootDirectory: z.string(),
});
export type FilesystemConfig = z.infer<typeof FilesystemConfigSchema>;

/**
 * Cloudflare R2 config — an S3-compatible endpoint keyed by account, with static credentials.
 * The bucket to open is the top-level `bucketName`, mirroring Go's single `BucketName` field.
 */
export const R2ConfigSchema = z.object({
  accountID: z.string(),
  accessKeyID: z.string(),
  secretAccessKey: z.string(),
});
export type R2Config = z.infer<typeof R2ConfigSchema>;

/** Backblaze B2 config — an S3-compatible endpoint keyed by region, with application keys. */
export const BackblazeB2ConfigSchema = z.object({
  applicationKeyID: z.string(),
  applicationKey: z.string(),
  region: z.string(),
});
export type BackblazeB2Config = z.infer<typeof BackblazeB2ConfigSchema>;

/**
 * Upload-manager config. Replaces the Go `env:`-tagged struct + ozzo `ValidateWithContext`.
 *
 * `bucketName` names the manager for metrics/tracing (`<bucketName>_uploader`), is the bucket
 * every backend opens, and is required. `bucketPrefix`, when set, is transparently prepended to
 * every key (Go's `blob.PrefixedBucket`). `circuitBreaker` feeds `@primandproper/circuitbreaking`'s
 * `provideCircuitBreaker`. `memory` (default) keeps blobs in a `Map`; `filesystem` writes under a
 * root dir; `s3` and `gcp` resolve ambient credentials; `r2`/`backblaze_b2` speak S3 via a custom
 * endpoint and so carry their own credentials.
 */
export const UploadsConfigSchema = z
  .object({
    provider: z
      .enum([
        MEMORY_PROVIDER,
        FILESYSTEM_PROVIDER,
        S3_PROVIDER,
        GCP_PROVIDER,
        R2_PROVIDER,
        BACKBLAZE_B2_PROVIDER,
      ])
      .default(MEMORY_PROVIDER),
    bucketName: z.string().min(1, "bucketName is required"),
    bucketPrefix: z.string().default(""),
    /**
     * Maximum bytes accepted by a single `save`. `0` (default) disables the backstop. A byte
     * body over the limit is rejected before the write; a stream body errors mid-transfer once it
     * crosses the limit (no full-payload buffering).
     */
    maxSizeBytes: z.number().int().nonnegative().default(0),
    filesystem: FilesystemConfigSchema.optional(),
    r2: R2ConfigSchema.optional(),
    backblazeB2: BackblazeB2ConfigSchema.optional(),
    circuitBreaker: CircuitBreakerConfigSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    const requireSub = (
      provider: string,
      key: "filesystem" | "r2" | "backblazeB2",
      present: boolean,
    ): void => {
      if (cfg.provider === provider && !present) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} config is required when provider is '${provider}'`,
        });
      }
    };
    requireSub(FILESYSTEM_PROVIDER, "filesystem", cfg.filesystem !== undefined);
    requireSub(R2_PROVIDER, "r2", cfg.r2 !== undefined);
    requireSub(BACKBLAZE_B2_PROVIDER, "backblazeB2", cfg.backblazeB2 !== undefined);
  });

export type UploadsConfig = z.infer<typeof UploadsConfigSchema>;
export type UploadsConfigInput = z.input<typeof UploadsConfigSchema>;
