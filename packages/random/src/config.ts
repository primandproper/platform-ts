import { z } from "zod";

/**
 * Random generator config. Replaces the Go `env:`-tagged struct + ozzo validation. The
 * `standard` provider draws cryptographically secure bytes from WebCrypto; `noop` returns
 * empty values (tests only).
 */
export const RandomConfigSchema = z.object({
  provider: z.enum(["standard", "noop"]).default("standard"),
});

export type RandomConfig = z.infer<typeof RandomConfigSchema>;
export type RandomConfigInput = z.input<typeof RandomConfigSchema>;
