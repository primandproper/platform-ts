import { z } from "zod";

/**
 * Node analytics config. Replaces the Go `env:`-tagged struct + ozzo `ValidateWithContext`.
 * Only zero-dependency providers ship today; SDK-backed providers (Segment/PostHog/
 * Rudderstack) are a documented future extension — see `index.node.ts`.
 */
export const NodeAnalyticsConfigSchema = z.object({
  provider: z.enum(["noop", "memory", "console"]).default("noop"),
});

export type NodeAnalyticsConfig = z.infer<typeof NodeAnalyticsConfigSchema>;
export type NodeAnalyticsConfigInput = z.input<typeof NodeAnalyticsConfigSchema>;

/**
 * Browser analytics config. Same provider set and shape as the Node config, so call-site
 * code is identical across environments. SDK-backed browser providers are a future
 * extension — see `index.browser.ts`.
 */
export const BrowserAnalyticsConfigSchema = z.object({
  provider: z.enum(["noop", "memory", "console"]).default("noop"),
});

export type BrowserAnalyticsConfig = z.infer<typeof BrowserAnalyticsConfigSchema>;
export type BrowserAnalyticsConfigInput = z.input<typeof BrowserAnalyticsConfigSchema>;
