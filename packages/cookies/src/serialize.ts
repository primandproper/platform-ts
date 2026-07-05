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
 * The largest a serialized cookie can be before browsers begin silently dropping it. The
 * spec-common per-cookie ceiling is ~4096 bytes; 4093 leaves room for the `Set-Cookie: `
 * framing. A store warns (never throws) when a cookie exceeds this.
 */
export const MAX_COOKIE_BYTES = 4093;

/** UTF-8 byte length of a serialized cookie string, for the {@link MAX_COOKIE_BYTES} guard. */
export function cookieByteLength(serialized: string): number {
  return new TextEncoder().encode(serialized).length;
}

// RFC 6265 grammar guards so a hostile name/domain/path can't inject extra Set-Cookie attributes
// (e.g. a name of `a; Domain=evil.com`). These mirror the reference `cookie` package's checks.
const COOKIE_NAME_REGEXP = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_DOMAIN_REGEXP =
  /^([.]?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
// Path chars: space..`:` and `=`..`~`, i.e. excludes CTLs, `;`, and `<`.
const COOKIE_PATH_REGEXP = /^[ -:=-~]*$/;

/**
 * Serializes a cookie into a `Set-Cookie` header value (RFC 6265 syntax). The value is
 * URI-encoded so arbitrary strings are safe to round-trip through {@link parseCookieHeader}.
 */
export function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions = {},
): string {
  if (!COOKIE_NAME_REGEXP.test(name)) {
    throw new TypeError(`invalid cookie name: ${JSON.stringify(name)}`);
  }
  const segments = [`${name}=${encodeURIComponent(value)}`];

  if (options.maxAge !== undefined) {
    if (!Number.isFinite(options.maxAge)) {
      throw new TypeError(`invalid cookie Max-Age: ${String(options.maxAge)}`);
    }
    segments.push(`Max-Age=${Math.trunc(options.maxAge).toString()}`);
  }
  if (options.domain !== undefined) {
    if (!COOKIE_DOMAIN_REGEXP.test(options.domain)) {
      throw new TypeError(`invalid cookie Domain: ${JSON.stringify(options.domain)}`);
    }
    segments.push(`Domain=${options.domain}`);
  }
  if (options.path !== undefined) {
    if (!COOKIE_PATH_REGEXP.test(options.path)) {
      throw new TypeError(`invalid cookie Path: ${JSON.stringify(options.path)}`);
    }
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
    const rawValue = pair.slice(eq + 1).trim();
    let value: string;
    try {
      value = decodeURIComponent(rawValue);
    } catch {
      // Hostile/malformed percent-encoding (e.g. `a=%zz`, or a stray `%` written by another
      // script into document.cookie) must never throw — pass the raw value through undecoded
      // rather than dropping the pair.
      value = rawValue;
    }
    cookies.set(name, value);
  }

  return cookies;
}
