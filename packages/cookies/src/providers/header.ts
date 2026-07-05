import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type { CookieStore } from "../cookies.js";
import {
  cookieByteLength,
  MAX_COOKIE_BYTES,
  parseCookieHeader,
  serializeCookie,
  type CookieOptions,
} from "../serialize.js";

const o11yName = "cookies";

export interface HeaderCookieStoreOptions {
  /** The incoming `Cookie:` request header to read from. Defaults to empty. */
  header?: string;
  /** Attributes merged under every `set`/`delete` call. */
  defaults?: CookieOptions;
}

/**
 * Server-side cookie store. Reads from an incoming `Cookie:` request header and accumulates
 * pending `Set-Cookie` strings as cookies are set or deleted; a handler emits them via
 * {@link HeaderCookieStore.headers}. Pure strings — Node-free — so it lives universal even
 * though its modality is server. Reads reflect writes within the same request.
 */
export class HeaderCookieStore implements CookieStore {
  readonly #cookies: Map<string, string>;
  readonly #pending = new Map<string, string>();
  readonly #defaults: CookieOptions;
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(options: HeaderCookieStoreOptions = {}, deps: ObservabilityDeps = {}) {
    this.#cookies = parseCookieHeader(options.header ?? "");
    this.#defaults = options.defaults ?? {};
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  get(name: string): string | undefined {
    return this.#cookies.get(name);
  }

  getAll(): Map<string, string> {
    return new Map(this.#cookies);
  }

  set(name: string, value: string, options: CookieOptions = {}): void {
    this.#cookies.set(name, value);
    const serialized = serializeCookie(name, value, { ...this.#defaults, ...options });
    this.#warnIfOversized(name, serialized);
    this.#pending.set(name, serialized);
    this.#logger.debug("cookie set");
  }

  #warnIfOversized(name: string, serialized: string): void {
    const bytes = cookieByteLength(serialized);
    if (bytes > MAX_COOKIE_BYTES) {
      this.#logger.warn("cookie exceeds size limit and may be dropped by the browser", {
        name,
        bytes,
        limit: MAX_COOKIE_BYTES,
      });
    }
  }

  delete(name: string, options: CookieOptions = {}): void {
    this.#cookies.delete(name);
    // Expire by setting an empty value with a zero Max-Age and a past Expires.
    this.#pending.set(
      name,
      serializeCookie(name, "", {
        ...this.#defaults,
        ...options,
        maxAge: 0,
        expires: new Date(0),
      }),
    );
    this.#logger.debug("cookie deleted");
  }

  /** The accumulated `Set-Cookie` header values to write onto the response. */
  headers(): string[] {
    return [...this.#pending.values()];
  }
}
