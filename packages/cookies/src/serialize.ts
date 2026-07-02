/**
 * Universal cookie serialization/parsing per RFC 6265. Pure string functions — no Node
 * built-ins, no DOM globals — so the same logic backs both the browser (`document.cookie`)
 * and server (`Set-Cookie`/`Cookie` header) providers. Values are URI-encoded on the way
 * out and URI-decoded on the way in, mirroring the Go platform's cookie handling.
 */

/** `SameSite` cookie policy. */
export type SameSite = "strict" | "lax" | "none";

/** Attributes for a single cookie, used by {@link serializeCookie}. */
export interface CookieOptions {
  /** Restricts the cookie to a path prefix. */
  path?: string;
  /** Restricts the cookie to a domain. */
  domain?: string;
  /** Lifetime in seconds. `0` expires the cookie immediately. */
  maxAge?: number;
  /** Absolute expiry; serialized as an RFC 1123 `Expires` date. */
  expires?: Date;
  /** Hides the cookie from client-side scripts. */
  httpOnly?: boolean;
  /** Restricts the cookie to secure (HTTPS) requests. */
  secure?: boolean;
  /** Cross-site delivery policy. */
  sameSite?: SameSite;
}

const SAME_SITE_LABELS: Record<SameSite, string> = {
  strict: "Strict",
  lax: "Lax",
  none: "None",
};

/**
 * Serializes a cookie into a `Set-Cookie` header value (RFC 6265 syntax). The value is
 * URI-encoded so arbitrary strings are safe to round-trip through {@link parseCookieHeader}.
 */
export function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions = {},
): string {
  const segments = [`${name}=${encodeURIComponent(value)}`];

  if (options.maxAge !== undefined) {
    segments.push(`Max-Age=${Math.trunc(options.maxAge).toString()}`);
  }
  if (options.domain !== undefined) {
    segments.push(`Domain=${options.domain}`);
  }
  if (options.path !== undefined) {
    segments.push(`Path=${options.path}`);
  }
  if (options.expires !== undefined) {
    segments.push(`Expires=${options.expires.toUTCString()}`);
  }
  if (options.httpOnly === true) {
    segments.push("HttpOnly");
  }
  if (options.secure === true) {
    segments.push("Secure");
  }
  if (options.sameSite !== undefined) {
    segments.push(`SameSite=${SAME_SITE_LABELS[options.sameSite]}`);
  }

  return segments.join("; ");
}

/**
 * Parses a `Cookie:` request header (`name=value; name2=value2`) into a map of decoded
 * values. Malformed pairs (no `=`, empty name) are skipped. On a repeated name the first
 * occurrence wins, matching browser request-header semantics.
 */
export function parseCookieHeader(header: string): Map<string, string> {
  const cookies = new Map<string, string>();
  if (header === "") {
    return cookies;
  }

  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const name = pair.slice(0, eq).trim();
    if (name === "") {
      continue;
    }
    if (cookies.has(name)) {
      continue;
    }
    cookies.set(name, decodeURIComponent(pair.slice(eq + 1).trim()));
  }

  return cookies;
}
