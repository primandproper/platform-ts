import { z } from "zod";

/**
 * Encryption config. Replaces the Go `env:`-tagged struct + ozzo `ValidateWithContext`.
 * The AES-GCM key is supplied as raw key bytes, base64-encoded, and must decode to a valid
 * AES key length (128, 192, or 256 bits).
 */
export const EncryptionConfigSchema = z
  .object({
    provider: z.enum(["aes-gcm", "passthrough"]).default("aes-gcm"),
    /** Base64-encoded raw AES key. Required for the `aes-gcm` provider. */
    key: z.string().optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.provider === "aes-gcm" && cfg.key === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["key"],
        message: "key is required when provider is 'aes-gcm'",
      });
    }
  });

export type EncryptionConfig = z.infer<typeof EncryptionConfigSchema>;
export type EncryptionConfigInput = z.input<typeof EncryptionConfigSchema>;

/** Hashing config. Defaults to SHA-256, the safe lowest-common-denominator. */
export const HashingConfigSchema = z.object({
  algorithm: z.enum(["SHA-256", "SHA-384", "SHA-512"]).default("SHA-256"),
});

export type HashingConfig = z.infer<typeof HashingConfigSchema>;
export type HashingConfigInput = z.input<typeof HashingConfigSchema>;
