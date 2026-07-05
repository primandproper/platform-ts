import type { BulkTextIndex, TextHit } from "../text.js";

/** A {@link TextIndex} that indexes nothing; every search is empty. */
export class NoopTextIndex implements BulkTextIndex {
  index(): Promise<void> {
    return Promise.resolve();
  }

  indexMany(): Promise<void> {
    return Promise.resolve();
  }

  search(): Promise<TextHit[]> {
    return Promise.resolve([]);
  }

  delete(): Promise<void> {
    return Promise.resolve();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }
}
