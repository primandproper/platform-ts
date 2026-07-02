import { RetryConfigSchema } from "@primandproper/retry";
import { z } from "zod";

/** Thirty seconds, in milliseconds — the default per-request timeout. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Universal HTTP client config. Replaces the Go `env:`-tagged struct + ozzo validation; the
 * same schema applies on Node and in the browser since both share the global `fetch`.
 */
export const HttpClientConfigSchema = z.object({
  /** Resolved against per-request relative URLs. Absolute request URLs ignore it. */
  baseUrl: z.string().url().optional(),
  /** Headers sent on every request, overridable per request. */
  headers: z.record(z.string(), z.string()).default({}),
  /** Per-request timeout in milliseconds. `0` disables the timeout. */
  timeoutMs: z.number().int().nonnegative().default(DEFAULT_TIMEOUT_MS),
  /**
   * Optional retry policy for failed requests (network errors, timeouts). Omitted means no
   * retries — a single attempt. When set, defaults are filled by {@link RetryConfigSchema}.
   */
  retry: RetryConfigSchema.optional(),
});

export type HttpClientConfig = z.infer<typeof HttpClientConfigSchema>;
export type HttpClientConfigInput = z.input<typeof HttpClientConfigSchema>;
