import type { ObservabilityDeps } from "@primandproper/observability";

import { SecretsConfigSchema, type SecretsConfigInput } from "./config.js";
import { EnvSecretSource } from "./providers/env.js";
import { NoopSecretSource } from "./providers/noop.js";
import { StaticSecretSource } from "./providers/static.js";
import type { SecretSource } from "./secrets.js";

export * from "./secrets.js";
export * from "./config.js";
export { EnvSecretSource } from "./providers/env.js";
export { StaticSecretSource } from "./providers/static.js";
export { NoopSecretSource } from "./providers/noop.js";

/**
 * Validates config and returns the matching {@link SecretSource}. Mirrors the Go platform's
 * `ProvideSecretManager`. Supports `env` (default), `static`, and `noop`.
 */
export function provideSecrets(
  config?: SecretsConfigInput,
  deps?: ObservabilityDeps,
): SecretSource {
  const cfg = SecretsConfigSchema.parse(config ?? {});
  switch (cfg.provider) {
    case "env":
      return new EnvSecretSource(cfg.env ? { prefix: cfg.env.prefix } : {}, deps);
    case "static":
      // superRefine guarantees this, but narrow for the type checker.
      if (cfg.static === undefined) {
        throw new Error("static config is required when provider is 'static'");
      }
      return new StaticSecretSource({ values: cfg.static.values });
    case "noop":
      return new NoopSecretSource();
  }
}
