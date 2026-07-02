import { z } from "zod";

/**
 * Default cookie attributes applied by a store unless a call overrides them. Mirrors the
 * Go platform's secure-by-default cookie builder: scoped to `/`, `Lax`, and `Secure`.
 */
const DefaultCookieOptionsSchema = z.object({
  path: z.string().default("/"),
  sameSite: z.enum(["strict", "lax", "none"]).default("lax"),
  secure: z.boolean().default(true),
});

export type DefaultCookieOptions = z.infer<typeof DefaultCookieOptionsSchema>;

/** Node cookie config. Replaces the Go `env:`-tagged struct + ozzo `ValidateWithContext`. */
export const NodeCookieConfigSchema = z.object({
  provider: z.enum(["header", "noop"]).default("header"),
  /** The incoming `Cookie:` request header the store reads from. */
  header: z.string().default(""),
  defaults: DefaultCookieOptionsSchema.default({}),
});

export type NodeCookieConfig = z.infer<typeof NodeCookieConfigSchema>;
export type NodeCookieConfigInput = z.input<typeof NodeCookieConfigSchema>;

/** Browser cookie config. Backed by `document.cookie` for the `document` provider. */
export const BrowserCookieConfigSchema = z.object({
  provider: z.enum(["document", "noop"]).default("document"),
  defaults: DefaultCookieOptionsSchema.default({}),
});

export type BrowserCookieConfig = z.infer<typeof BrowserCookieConfigSchema>;
export type BrowserCookieConfigInput = z.input<typeof BrowserCookieConfigSchema>;
