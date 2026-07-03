import { z } from "zod";

/** Credentials/options for the Segment provider. Used by both the Node and browser SDKs. */
export const SegmentConfigSchema = z.object({
  /** The Segment source write key. */
  writeKey: z.string().min(1),
});

export type SegmentConfig = z.infer<typeof SegmentConfigSchema>;

/** Credentials/options for the PostHog provider. Used by both the Node and browser SDKs. */
export const PostHogConfigSchema = z.object({
  /** The PostHog project API key. */
  apiKey: z.string().min(1),
  /** Host of a self-hosted PostHog instance. Defaults to PostHog Cloud (`https://app.posthog.com`). */
  host: z.string().url().optional(),
});

export type PostHogConfig = z.infer<typeof PostHogConfigSchema>;

/**
 * Analytics config. Replaces the Go `env:`-tagged struct + ozzo `ValidateWithContext`. One schema
 * serves both environments: `noop`/`memory`/`console` are universal, while `segment` and `posthog`
 * resolve to the Node SDK on the server and the browser SDK in the browser behind an identical
 * factory signature — so call-site code is copy-paste portable across contexts.
 *
 * The `superRefine` enforces that the selected vendor's credentials are present — the analogue of
 * Go's `validation.When(provider == ..., Required)`.
 */
export const AnalyticsConfigSchema = z
  .object({
    provider: z.enum(["noop", "memory", "console", "segment", "posthog"]).default("noop"),
    segment: SegmentConfigSchema.optional(),
    posthog: PostHogConfigSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.provider === "segment" && !cfg.segment) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["segment"],
        message: "segment config is required when provider is 'segment'",
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

export type AnalyticsConfig = z.infer<typeof AnalyticsConfigSchema>;
export type AnalyticsConfigInput = z.input<typeof AnalyticsConfigSchema>;
