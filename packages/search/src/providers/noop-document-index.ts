import type { DocumentIndex } from "../document-index.js";

/**
 * A {@link DocumentIndex} that stores nothing; every search is an empty array. The factory
 * default, matching platform-go where an unknown/empty provider falls back to noop. Universal:
 * no Node built-ins, no circuit breaker, no observability.
 */
export class NoopDocumentIndex<T> implements DocumentIndex<T> {
  search(): Promise<T[]> {
    return Promise.resolve([]);
  }

  index(): Promise<void> {
    return Promise.resolve();
  }

  delete(): Promise<void> {
    return Promise.resolve();
  }

  wipe(): Promise<void> {
    return Promise.resolve();
  }
}
