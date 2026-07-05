import type { ObservabilityDeps } from "@primandproper/observability";

import {
  PasswordConfigSchema,
  type PasswordConfigInput,
  TOTPConfigSchema,
  type TOTPConfigInput,
  TokensConfigSchema,
  type TokensConfigInput,
} from "./config.js";
import type { PasswordHasher } from "./password.js";
import { ScryptHasher } from "./providers/scrypt.js";
import { RandomTokenGenerator } from "./providers/tokens.js";
import { RFC6238TOTP } from "./providers/totp.js";
import type { TokenGenerator } from "./tokens.js";
import type { TOTP } from "./totp.js";

export * from "./errors.js";
export * from "./password.js";
export * from "./totp.js";
export * from "./tokens.js";
export * from "./config.js";
export { ScryptHasher } from "./providers/scrypt.js";
export { RFC6238TOTP } from "./providers/totp.js";
export { RandomTokenGenerator } from "./providers/tokens.js";

/**
 * Validates config and returns the matching {@link PasswordHasher}. Mirrors the Go platform's
 * `ProvidePasswordHasher`. Only `scrypt` is implemented; argon2id is a documented future provider.
 */
export function providePasswordHasher(
  config?: PasswordConfigInput,
  deps?: ObservabilityDeps,
): PasswordHasher {
  const cfg = PasswordConfigSchema.parse(config ?? {});
  // Only `scrypt` exists today; argon2id is a documented future provider.
  return new ScryptHasher(cfg.scrypt ?? {}, deps);
}

/** Validates config and returns the matching {@link TOTP}. Mirrors the Go platform's `ProvideTOTP`. */
export function provideTOTP(config?: TOTPConfigInput, deps?: ObservabilityDeps): TOTP {
  const cfg = TOTPConfigSchema.parse(config ?? {});
  return new RFC6238TOTP(
    { algorithm: cfg.algorithm, digits: cfg.digits, period: cfg.period },
    deps,
  );
}

/**
 * Validates config and returns the matching {@link TokenGenerator}. Mirrors the Go platform's
 * `ProvideTokenGenerator`.
 */
export function provideTokenGenerator(config?: TokensConfigInput): TokenGenerator {
  const cfg = TokensConfigSchema.parse(config ?? {});
  return new RandomTokenGenerator({ byteLength: cfg.byteLength });
}
