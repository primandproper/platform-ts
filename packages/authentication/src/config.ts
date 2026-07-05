import { z } from "zod";

/**
 * scrypt-provider config. `cost` is the CPU/memory factor `N` (must be a power of two),
 * `blockSize` is `r`, `parallelization` is `p`, and the remaining fields size the salt and
 * derived key. Defaults follow Node's documented recommendations for interactive logins.
 */
export const ScryptConfigSchema = z.object({
  cost: z
    .number()
    .int()
    .positive()
    .refine((n) => n > 1 && (n & (n - 1)) === 0, {
      message: "scrypt cost must be a power of two greater than one",
    })
    .default(16384),
  blockSize: z.number().int().positive().default(8),
  parallelization: z.number().int().positive().default(1),
  keyLength: z.number().int().positive().default(64),
  saltLength: z.number().int().positive().default(16),
});

export type ScryptConfig = z.infer<typeof ScryptConfigSchema>;

/**
 * Password-hashing config. `scrypt` (default) uses `node:crypto`. `argon2id` is documented as
 * the intended stronger provider but needs a native dependency and is not implemented here.
 */
export const PasswordConfigSchema = z.object({
  provider: z.enum(["scrypt"]).default("scrypt"),
  scrypt: ScryptConfigSchema.optional(),
});

export type PasswordConfig = z.infer<typeof PasswordConfigSchema>;
export type PasswordConfigInput = z.input<typeof PasswordConfigSchema>;

/** TOTP config (RFC 6238). Defaults match the near-universal authenticator-app expectations. */
export const TOTPConfigSchema = z.object({
  algorithm: z.enum(["SHA1", "SHA256", "SHA512"]).default("SHA1"),
  digits: z.number().int().positive().default(6),
  period: z.number().int().positive().default(30),
});

export type TOTPConfig = z.infer<typeof TOTPConfigSchema>;
export type TOTPConfigInput = z.input<typeof TOTPConfigSchema>;

/** Token-generator config. `byteLength` is the default entropy used when a caller omits it. */
export const TokensConfigSchema = z.object({
  byteLength: z.number().int().positive().default(32),
});

export type TokensConfig = z.infer<typeof TokensConfigSchema>;
export type TokensConfigInput = z.input<typeof TokensConfigSchema>;
