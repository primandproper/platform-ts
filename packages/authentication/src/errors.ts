import { PlatformError } from "@primandproper/errors";

/** Thrown when a scrypt cost factor `N` is not a power of two greater than one. */
export class InvalidScryptCostError extends PlatformError {
  constructor(cost: number) {
    super(
      "authentication/invalid-scrypt-cost",
      `scrypt cost must be a power of two greater than one, got ${String(cost)}`,
    );
    this.name = "InvalidScryptCostError";
  }
}

/** Thrown when password hashing fails (e.g. the underlying scrypt call rejects). */
export class PasswordHashError extends PlatformError {
  constructor(cause: unknown) {
    super("authentication/password-hash-failed", "hashing password failed", {
      cause,
    });
    this.name = "PasswordHashError";
  }
}

/**
 * Thrown when a TOTP secret is not valid base32. Deliberately carries no fragment of the
 * secret in its message so a decode failure can be logged safely.
 */
export class InvalidTOTPSecretError extends PlatformError {
  constructor() {
    super("authentication/invalid-totp-secret", "TOTP secret is not valid base32");
    this.name = "InvalidTOTPSecretError";
  }
}

/** Thrown when a token byte length is not a positive integer. */
export class InvalidTokenLengthError extends PlatformError {
  constructor(byteLength: number) {
    super(
      "authentication/invalid-token-length",
      `token byte length must be a positive integer, got ${String(byteLength)}`,
    );
    this.name = "InvalidTokenLengthError";
  }
}
