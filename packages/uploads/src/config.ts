import { z } from "zod";

/** Filesystem-provider config: blobs are written under `dir`. */
export const FilesystemUploadsConfigSchema = z.object({
  dir: z.string(),
});

export type FilesystemUploadsConfig = z.infer<typeof FilesystemUploadsConfigSchema>;

/**
 * S3-provider config: blobs live in `bucket`. `endpoint` and `forcePathStyle` point the
 * client at an S3-compatible service (MinIO, LocalStack); omit them for AWS. `credentials`
 * are optional — omit them to let the SDK resolve its default chain.
 */
export const S3UploadsConfigSchema = z.object({
  bucket: z.string(),
  region: z.string().default("us-east-1"),
  endpoint: z.string().optional(),
  forcePathStyle: z.boolean().default(false),
  credentials: z
    .object({
      accessKeyId: z.string(),
      secretAccessKey: z.string(),
      sessionToken: z.string().optional(),
    })
    .optional(),
});

export type S3UploadsConfig = z.infer<typeof S3UploadsConfigSchema>;

/**
 * Uploads config. Replaces the Go `env:`-tagged struct + ozzo `ValidateWithContext`.
 * `memory` (default) keeps blobs in a `Map`; `filesystem` writes them under a base `dir`;
 * `s3` stores them in an S3 (or S3-compatible) bucket; `noop` discards them. S3 needs the
 * `@aws-sdk/client-s3` SDK and stays server-side.
 */
export const UploadsConfigSchema = z
  .object({
    provider: z.enum(["memory", "filesystem", "s3", "noop"]).default("memory"),
    filesystem: FilesystemUploadsConfigSchema.optional(),
    s3: S3UploadsConfigSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.provider === "filesystem" && cfg.filesystem === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["filesystem"],
        message: "filesystem config is required when provider is 'filesystem'",
      });
    }
    if (cfg.provider === "s3" && cfg.s3 === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["s3"],
        message: "s3 config is required when provider is 's3'",
      });
    }
  });

export type UploadsConfig = z.infer<typeof UploadsConfigSchema>;
export type UploadsConfigInput = z.input<typeof UploadsConfigSchema>;
