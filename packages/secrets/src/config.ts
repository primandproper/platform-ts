import { z } from "zod";

/** Static-provider config: an inline map of secret keys to values. */
export const StaticSecretsConfigSchema = z.object({
  values: z.record(z.string()).default({}),
});

export type StaticSecretsConfig = z.infer<typeof StaticSecretsConfigSchema>;

/** Environment-provider config. An optional prefix is prepended to every lookup. */
export const EnvSecretsConfigSchema = z.object({
  prefix: z.string().default(""),
});

export type EnvSecretsConfig = z.infer<typeof EnvSecretsConfigSchema>;

/** GCP Secret Manager config. Mirrors Go's `gcp.Config` — `projectID` is required. */
export const GCPSecretsConfigSchema = z.object({
  projectID: z.string().min(1),
});

export type GCPSecretsConfig = z.infer<typeof GCPSecretsConfigSchema>;

/** AWS SSM Parameter Store config. Mirrors Go's `ssm.Config` — `region` is required. */
export const SSMSecretsConfigSchema = z.object({
  region: z.string().min(1),
  prefix: z.string().default(""),
});

export type SSMSecretsConfig = z.infer<typeof SSMSecretsConfigSchema>;

/** Kubernetes secret source config. Mirrors Go's `kubectl.Config` — `namespace` is required. */
export const KubectlSecretsConfigSchema = z.object({
  namespace: z.string().min(1),
  kubeconfig: z.string().default(""),
});

export type KubectlSecretsConfig = z.infer<typeof KubectlSecretsConfigSchema>;

/**
 * Caching config for the remote providers (gcp/ssm/kubectl). Short-TTL memoization plus in-flight
 * de-duplication in front of the source, so repeated reads don't each round-trip and a provider
 * blip keeps serving cached values. On by default with a short TTL; `enabled: false` opts out.
 */
export const SecretsCacheConfigSchema = z.object({
  enabled: z.boolean().default(true),
  ttlMs: z.number().int().nonnegative().default(30_000),
});

export type SecretsCacheConfig = z.infer<typeof SecretsCacheConfigSchema>;

/** Providers whose config block is mandatory — the analogue of Go's per-provider `When(Required)`. */
const PROVIDERS_REQUIRING_CONFIG = ["static", "gcp", "ssm", "kubectl"] as const;

/**
 * Secrets config. Replaces the Go `env:`-tagged struct + ozzo `ValidateWithContext`. `env`
 * (default) reads `process.env`; `static` serves an inline map; `noop` returns nothing; `gcp`,
 * `ssm`, and `kubectl` back onto GCP Secret Manager, AWS SSM Parameter Store, and Kubernetes
 * secrets respectively — all server-side, each requiring its own config block.
 */
export const SecretsConfigSchema = z
  .object({
    provider: z.enum(["env", "static", "noop", "gcp", "ssm", "kubectl"]).default("env"),
    env: EnvSecretsConfigSchema.optional(),
    static: StaticSecretsConfigSchema.optional(),
    gcp: GCPSecretsConfigSchema.optional(),
    ssm: SSMSecretsConfigSchema.optional(),
    kubectl: KubectlSecretsConfigSchema.optional(),
    cache: SecretsCacheConfigSchema.default({}),
  })
  .superRefine((cfg, ctx) => {
    for (const provider of PROVIDERS_REQUIRING_CONFIG) {
      if (cfg.provider === provider && cfg[provider] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [provider],
          message: `${provider} config is required when provider is '${provider}'`,
        });
      }
    }
  });

export type SecretsConfig = z.infer<typeof SecretsConfigSchema>;
export type SecretsConfigInput = z.input<typeof SecretsConfigSchema>;
