import { z } from "zod";

/** Locales this package exposes by name. Keep this list small and curated. */
export const FAKE_LOCALES = ["en", "en_US", "en_GB"] as const;

/** Universal fake-data config. Mirrors Go's `gofakeit` seeded determinism. */
export const FakeConfigSchema = z.object({
  /** When set, the instance is seeded so output is deterministic and reproducible. */
  seed: z.number().int().optional(),
  /** Locale to draw values from; defaults to the library default English locale. */
  locale: z.enum(FAKE_LOCALES).default("en"),
});

export type FakeLocale = (typeof FAKE_LOCALES)[number];
export type FakeConfig = z.infer<typeof FakeConfigSchema>;
export type FakeConfigInput = z.input<typeof FakeConfigSchema>;
