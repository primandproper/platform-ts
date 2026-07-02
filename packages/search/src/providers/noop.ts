import type { TextHit, TextIndex } from "../text.js";
import type { VectorHit, VectorIndex } from "../vector.js";

/** A {@link TextIndex} that indexes nothing; every search is empty. */
export class NoopTextIndex implements TextIndex {
  index(): Promise<void> {
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

/** A {@link VectorIndex} that indexes nothing; every query is empty. */
export class NoopVectorIndex implements VectorIndex {
  upsert(): Promise<void> {
    return Promise.resolve();
  }

  query(): Promise<VectorHit[]> {
    return Promise.resolve([]);
  }

  delete(): Promise<void> {
    return Promise.resolve();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }
}
