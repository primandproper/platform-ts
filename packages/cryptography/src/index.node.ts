import type { ObservabilityDeps } from "@primandproper/observability";

import {
  EncryptionConfigSchema,
  type EncryptionConfigInput,
  HashingConfigSchema,
  type HashingConfigInput,
} from "./config.js";
import type { Encryptor } from "./encryption.js";
import type { Hasher } from "./hashing.js";
import { AesGcmEncryptor } from "./providers/aes-gcm.js";
import { PassthroughEncryptor } from "./providers/passthrough.js";
import { Salsa20Encryptor } from "./providers/salsa20.js";
import { SubtleHasher } from "./providers/subtle-hasher.js";

export * from "./base64.js";
export * from "./config.js";
export * from "./encryption.js";
export * from "./hashing.js";
export { AesGcmEncryptor, importAesGcmKey } from "./providers/aes-gcm.js";
export { PassthroughEncryptor } from "./providers/passthrough.js";
export { Salsa20Encryptor } from "./providers/salsa20.js";
export { SubtleHasher } from "./providers/subtle-hasher.js";

/**
 * Node default factory: validates config and returns the matching {@link Encryptor}. Mirrors
 * the Go platform's `Provide*`. Supports `aes-gcm` (default), `salsa20`, and `passthrough`
 * (tests only). Built on WebCrypto + noble, so this factory is identical to the browser
 * entry — portable call-sites.
 */
export function provideEncryption(
  config?: EncryptionConfigInput,
  deps?: ObservabilityDeps,
): Encryptor {
  const cfg = EncryptionConfigSchema.parse(config ?? {});
  switch (cfg.provider) {
    case "aes-gcm":
      // superRefine guarantees this, but narrow for the type checker.
      if (cfg.key === undefined) {
        throw new Error("key is required when provider is 'aes-gcm'");
      }
      return new AesGcmEncryptor({ key: cfg.key }, deps);
    case "salsa20":
      if (cfg.key === undefined) {
        throw new Error("key is required when provider is 'salsa20'");
      }
      return new Salsa20Encryptor({ key: cfg.key }, deps);
    case "passthrough":
      return new PassthroughEncryptor();
  }
}

/**
 * Node default factory: validates config and returns the matching {@link Hasher}. Supports
 * `SHA-256` (default), `SHA-384`, and `SHA-512`.
 */
export function provideHashing(
  config?: HashingConfigInput,
  deps?: ObservabilityDeps,
): Hasher {
  const cfg = HashingConfigSchema.parse(config ?? {});
  return new SubtleHasher({ algorithm: cfg.algorithm }, deps);
}
