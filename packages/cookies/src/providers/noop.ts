import type { CookieStore } from "../cookies.js";

/** Universal cookie store that holds nothing; every read is empty and writes are dropped. */
export class NoopCookieStore implements CookieStore {
  get(): string | undefined {
    return undefined;
  }

  getAll(): Map<string, string> {
    return new Map();
  }

  set(): void {}

  delete(): void {}
}
