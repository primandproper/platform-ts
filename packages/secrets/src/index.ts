import type { ObservabilityDeps } from "@primandproper/observability";

import {
  SecretsConfigSchema,
  type SecretsCacheConfig,
  type SecretsConfigInput,
} from "./config.js";
import { CachingSecretSource } from "./providers/caching.js";
import { EnvSecretSource } from "./providers/env.js";
import { GCPSecretSource } from "./providers/gcp.node.js";
import { KubectlSecretSource } from "./providers/kubectl.node.js";
import { NoopSecretSource } from "./providers/noop.js";
import { SSMSecretSource } from "./providers/ssm.node.js";
import { StaticSecretSource } from "./providers/static.js";
import type { SecretSource } from "./secrets.js";

export * from "./secrets.js";
export * from "./config.js";
export { EnvSecretSource, type EnvSecretSourceOptions } from "./providers/env.js";
export { StaticSecretSource } from "./providers/static.js";
export { NoopSecretSource } from "./providers/noop.js";
export {
  GCPSecretSource,
  type GCPSecretSourceOptions,
  type GCPSecretAccessor,
} from "./providers/gcp.node.js";
export {
  SSMSecretSource,
  type SSMSecretSourceOptions,
  type SSMParameterAccessor,
} from "./providers/ssm.node.js";
export {
  KubectlSecretSource,
  type KubectlSecretSourceOptions,
  type K8sSecretReader,
} from "./providers/kubectl.node.js";
export {
  CachingSecretSource,
  type CachingSecretSourceOptions,
  DEFAULT_SECRET_TTL_MS,
} from "./providers/caching.js";

/**
 * Narrows a per-provider config the schema's `superRefine` has already guaranteed present, so the
 * type checker sees a defined value without a non-null assertion.
 */
function required<T>(value: T | undefined, provider: string): T {
  if (value === undefined) {
    throw new Error(`${provider} config is required when provider is '${provider}'`);
  }
  return value;
}

/**
 * Validates config and returns the matching {@link SecretSource}. Mirrors the Go platform's
 * `ProvideSecretSource`. Supports `env` (default), `static`, `noop`, `gcp`, `ssm`, and `kubectl`.
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
      return new StaticSecretSource({ values: required(cfg.static, "static").values });
    case "noop":
      return new NoopSecretSource();
    case "gcp":
      return maybeCache(
        new GCPSecretSource({ projectID: required(cfg.gcp, "gcp").projectID }, deps),
        cfg.cache,
        deps,
      );
    case "ssm": {
      const ssm = required(cfg.ssm, "ssm");
      return maybeCache(
        new SSMSecretSource({ region: ssm.region, prefix: ssm.prefix }, deps),
        cfg.cache,
        deps,
      );
    }
    case "kubectl": {
      const kubectl = required(cfg.kubectl, "kubectl");
      return maybeCache(
        new KubectlSecretSource(
          { namespace: kubectl.namespace, kubeconfig: kubectl.kubeconfig },
          deps,
        ),
        cfg.cache,
        deps,
      );
    }
  }
}

/**
 * Wraps a remote source in a {@link CachingSecretSource} unless caching is disabled or given a
 * zero TTL. Local sources (env/static/noop) are never wrapped — there is nothing to memoize.
 */
function maybeCache(
  source: SecretSource,
  cache: SecretsCacheConfig,
  deps: ObservabilityDeps | undefined,
): SecretSource {
  if (!cache.enabled || cache.ttlMs <= 0) {
    return source;
  }
  return new CachingSecretSource(source, { ttlMs: cache.ttlMs }, deps);
}
