import { z } from "zod";

/** Static-provider config: an inline map of secret keys to values. */
export const StaticSecretsConfigSchema = z.object({
  values: z.record(z.string()).default({}),
});

export type StaticSecretsConfig = z.infer<typeof StaticSecretsConfigSchema>;

/** Environment-provider config. An optional prefix is stripped/added to every lookup. */
export const EnvSecretsConfigSchema = z.object({
  prefix: z.string().default(""),
});

export type EnvSecretsConfig = z.infer<typeof EnvSecretsConfigSchema>;

/**
 * Secrets config. Replaces the Go `env:`-tagged struct + ozzo `ValidateWithContext`.
 * `env` (default) reads `process.env`; `static` serves an inline map; `noop` returns
 * nothing. Cloud sources (GCP Secret Manager, AWS SSM, Kubernetes) are documented as
 * future providers — they need provider SDKs or mounted files and stay server-side.
 */
export const SecretsConfigSchema = z
  .object({
    provider: z.enum(["env", "static", "noop"]).default("env"),
    env: EnvSecretsConfigSchema.optional(),
    static: StaticSecretsConfigSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.provider === "static" && cfg.static === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["static"],
        message: "static config is required when provider is 'static'",
      });
    }
  });

export type SecretsConfig = z.infer<typeof SecretsConfigSchema>;
export type SecretsConfigInput = z.input<typeof SecretsConfigSchema>;
