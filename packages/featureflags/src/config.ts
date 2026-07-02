import { z } from "zod";

import type { FlagValue, JsonValue } from "./featureflags.js";

/** A JSON value, matching {@link JsonValue} in `featureflags.ts` for the static provider. */
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

/** Any flag value the static provider can hold — a primitive or a JSON structure. */
const FlagValueSchema: z.ZodType<FlagValue> = z.union([
  z.boolean(),
  z.number(),
  z.string(),
  JsonValueSchema,
]);

/**
 * A targeting rule: when every attribute in `when` matches the evaluation context's
 * attributes, the flag resolves to `value`. Rules are evaluated in order; the first match
 * wins, falling back to the flag's `default`.
 */
export const FlagRuleSchema = z.object({
  when: z.record(FlagValueSchema),
  value: FlagValueSchema,
});

export type FlagRule = z.infer<typeof FlagRuleSchema>;

/**
 * A single static flag: a base `value`, plus optional ordered targeting `rules` matched
 * against the evaluation context. A bare value is also accepted as shorthand.
 */
export const FlagDefinitionSchema = z.union([
  FlagValueSchema,
  z.object({
    value: FlagValueSchema,
    rules: z.array(FlagRuleSchema).default([]),
  }),
]);

export type FlagDefinition = z.infer<typeof FlagDefinitionSchema>;

/** The flag table the static provider evaluates against, keyed by flag name. */
export const FlagTableSchema = z.record(FlagDefinitionSchema);

export type FlagTable = z.infer<typeof FlagTableSchema>;

/** Credentials/options for the LaunchDarkly provider (server-side SDK). */
export const LaunchDarklyConfigSchema = z.object({
  sdkKey: z.string().min(1),
  initTimeoutSeconds: z.number().int().positive().optional(),
});

export type LaunchDarklyConfig = z.infer<typeof LaunchDarklyConfigSchema>;

/** Credentials/options for the PostHog provider (server-side SDK). */
export const PostHogConfigSchema = z.object({
  projectApiKey: z.string().min(1),
  personalApiKey: z.string().min(1),
  host: z.string().url().optional(),
  evaluateLocally: z.boolean().optional(),
});

export type PostHogConfig = z.infer<typeof PostHogConfigSchema>;

/**
 * Feature-flags config. Replaces the Go `env:`-tagged struct + ozzo `ValidateWithContext`. Flag
 * evaluation runs through an OpenFeature client for the SDK-backed providers (`launchdarkly`,
 * `posthog`); `static` and `noop` evaluate in-process. The `superRefine` enforces that the
 * selected SDK provider's credentials are present — the analogue of Go's
 * `validation.When(provider == ..., Required)`.
 */
export const FeatureFlagsConfigSchema = z
  .object({
    /** The static flag table; consulted only by the `static` provider. */
    flags: FlagTableSchema.default({}),
    provider: z.enum(["static", "noop", "launchdarkly", "posthog"]).default("static"),
    launchdarkly: LaunchDarklyConfigSchema.optional(),
    posthog: PostHogConfigSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.provider === "launchdarkly" && !cfg.launchdarkly) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["launchdarkly"],
        message: "launchdarkly config is required when provider is 'launchdarkly'",
      });
    }
    if (cfg.provider === "posthog" && !cfg.posthog) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["posthog"],
        message: "posthog config is required when provider is 'posthog'",
      });
    }
  });

export type FeatureFlagsConfig = z.infer<typeof FeatureFlagsConfigSchema>;
export type FeatureFlagsConfigInput = z.input<typeof FeatureFlagsConfigSchema>;
