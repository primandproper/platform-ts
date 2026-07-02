import type { CookieOptions } from "./serialize.js";

/**
 * The universal cookie-store contract. The same calls work against `document.cookie` in
 * the browser and against request/response headers on the server, so call-site code is
 * copy-paste portable. A missing cookie is `undefined` rather than a sentinel error — the
 * idiomatic-TypeScript divergence from the Go platform.
 */
export interface CookieStore {
  /** Returns the cookie value, or `undefined` when it is not set. */
  get(name: string): string | undefined;
  /** Returns every readable cookie as a `name → value` map. */
  getAll(): Map<string, string>;
  set(name: string, value: string, options?: CookieOptions): void;
  /** Removes a cookie. `options` (path/domain) must match how it was set. */
  delete(name: string, options?: CookieOptions): void;
}
