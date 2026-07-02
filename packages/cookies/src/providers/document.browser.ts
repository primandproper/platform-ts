import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type { DefaultCookieOptions } from "../config.js";
import type { CookieStore } from "../cookies.js";
import { parseCookieHeader, serializeCookie, type CookieOptions } from "../serialize.js";

const o11yName = "cookies";

export interface DocumentCookieStoreOptions {
  /** Attributes merged under every `set`/`delete` call. */
  defaults?: DefaultCookieOptions;
}

/**
 * Browser-only cookie store backed by the live `document.cookie`. Reads and writes go
 * straight through to the document, so values reflect changes made elsewhere on the page.
 */
export class DocumentCookieStore implements CookieStore {
  readonly #defaults: CookieOptions;
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(options: DocumentCookieStoreOptions = {}, deps: ObservabilityDeps = {}) {
    this.#defaults = options.defaults ?? {};
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  get(name: string): string | undefined {
    return this.#read().get(name);
  }

  getAll(): Map<string, string> {
    return this.#read();
  }

  set(name: string, value: string, options: CookieOptions = {}): void {
    document.cookie = serializeCookie(name, value, { ...this.#defaults, ...options });
    this.#logger.debug("cookie set");
  }

  delete(name: string, options: CookieOptions = {}): void {
    document.cookie = serializeCookie(name, "", {
      ...this.#defaults,
      ...options,
      maxAge: 0,
      expires: new Date(0),
    });
    this.#logger.debug("cookie deleted");
  }

  #read(): Map<string, string> {
    return parseCookieHeader(document.cookie);
  }
}
