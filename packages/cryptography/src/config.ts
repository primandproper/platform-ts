import { z } from "zod";

/**
 * Encryption config. Replaces the Go `env:`-tagged struct + ozzo `ValidateWithContext`.
 * The key is supplied as raw key bytes, base64-encoded. `aes-gcm` accepts a 128/192/256-bit
 * key; `salsa20` requires a 256-bit key.
 */
export const EncryptionConfigSchema = z
  .object({
    provider: z.enum(["aes-gcm", "salsa20", "passthrough"]).default("aes-gcm"),
    /** Base64-encoded raw key. Required for the `aes-gcm` and `salsa20` providers. */
    key: z.string().optional(),
  })
  .superRefine((cfg, ctx) => {
    if (
      (cfg.provider === "aes-gcm" || cfg.provider === "salsa20") &&
      cfg.key === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["key"],
        message: `key is required when provider is '${cfg.provider}'`,
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
