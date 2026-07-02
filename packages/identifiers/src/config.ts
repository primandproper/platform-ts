import { urlAlphabet } from "nanoid";
import { z } from "zod";

/** Selects which underlying scheme `provideIdentifierGenerator` builds. */
export const IdentifierScheme = z.enum(["nanoid", "ulid"]);
export type IdentifierScheme = z.infer<typeof IdentifierScheme>;

/**
 * Universal identifiers config. Replaces the Go `env:`-tagged struct + ozzo validation.
 *
 * `nanoid` yields random URL-safe IDs; `ulid` yields lexicographically sortable, k-sortable
 * IDs (preserving the time-ordering property the Go `rs/xid` IDs had). `alphabet`/`size`
 * apply only to the nanoid scheme.
 */
export const IdentifierConfigSchema = z.object({
  /** Which generator to build. */
  scheme: IdentifierScheme.default("nanoid"),
  /** nanoid alphabet; defaults to nanoid's URL-safe set. Ignored by the ulid scheme. */
  alphabet: z.string().min(1).default(urlAlphabet),
  /** nanoid ID length. nanoid's own default is 21. Ignored by the ulid scheme. */
  size: z.number().int().positive().default(21),
});

export type IdentifierConfig = z.infer<typeof IdentifierConfigSchema>;
export type IdentifierConfigInput = z.input<typeof IdentifierConfigSchema>;
