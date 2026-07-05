import { z } from "zod";

/**
 * Default cookie attributes applied by a store unless a call overrides them. Mirrors the
 * Go platform's secure-by-default cookie builder: scoped to `/`, `Lax`, and `Secure`.
 * `httpOnly` has no schema default here because it is meaningless in the browser
 * (`document.cookie` cannot set it) — the Node config defaults it to `true` (see below).
 *
 * NOTE: cookie stores do **not** sign or otherwise integrity-protect values. A value read
 * back is only as trustworthy as the client that sent it; never store a security decision
 * (roles, user ids, entitlements) in a bare cookie. For tamper-evident cookies, compose a
 * signing/encryption layer with `@primandproper/cryptography` before `set` and after `get`.
 */
const DefaultCookieOptionsSchema = z.object({
  path: z.string().default("/"),
  sameSite: z.enum(["strict", "lax", "none"]).default("lax"),
  secure: z.boolean().default(true),
  /**
   * Hides the cookie from client-side scripts. Defaults to `false` (the browser can't set
   * `HttpOnly` at all); the Node config overrides the default to `true`.
   */
  httpOnly: z.boolean().default(false),
});

export type DefaultCookieOptions = z.infer<typeof DefaultCookieOptionsSchema>;

/** Node cookie config. Replaces the Go `env:`-tagged struct + ozzo `ValidateWithContext`. */
export const NodeCookieConfigSchema = z.object({
  provider: z.enum(["header", "noop"]).default("header"),
  /** The incoming `Cookie:` request header the store reads from. */
  header: z.string().default(""),
  // Server cookies default to HttpOnly so a value is never exposed to page scripts unless
  // the caller opts out explicitly.
  defaults: DefaultCookieOptionsSchema.default({ httpOnly: true }),
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
