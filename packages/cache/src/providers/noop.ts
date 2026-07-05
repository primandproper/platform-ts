import type { Cache } from "../cache.js";

/** Universal cache that stores nothing; every read is a miss. */
export class NoopCache<T> implements Cache<T> {
  get(): Promise<T | undefined> {
    return Promise.resolve(undefined);
  }

  set(): Promise<void> {
    return Promise.resolve();
  }

  delete(): Promise<void> {
    return Promise.resolve();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
