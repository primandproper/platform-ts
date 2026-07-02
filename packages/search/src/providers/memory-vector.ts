import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type { VectorDocument, VectorHit, VectorIndex } from "../vector.js";

const o11yName = "search";

interface StoredVectorDocument {
  readonly vector: number[];
  readonly norm: number;
  readonly metadata?: Record<string, unknown>;
}

function norm(vector: number[]): number {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  return Math.sqrt(sum);
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

/**
 * An in-memory {@link VectorIndex}. Ranks by cosine similarity, treating a zero-norm vector as
 * maximally dissimilar (similarity 0) rather than dividing by zero. The default vector provider.
 */
export class MemoryVectorIndex implements VectorIndex {
  readonly #docs = new Map<string, StoredVectorDocument>();
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(deps: ObservabilityDeps = {}) {
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  upsert(doc: VectorDocument): Promise<void> {
    const vector = [...doc.vector];
    const stored: StoredVectorDocument = {
      vector,
      norm: norm(vector),
      ...(doc.metadata !== undefined ? { metadata: doc.metadata } : {}),
    };
    this.#docs.set(doc.id, stored);
    return Promise.resolve();
  }

  query(vector: number[], k: number): Promise<VectorHit[]> {
    const queryNorm = norm(vector);
    const hits: VectorHit[] = [];

    for (const [id, doc] of this.#docs) {
      if (doc.vector.length !== vector.length) {
        return Promise.reject(
          new Error(
            `query vector dimension ${String(vector.length)} does not match stored dimension ${String(doc.vector.length)} for document ${id}`,
          ),
        );
      }
      const denom = queryNorm * doc.norm;
      const score = denom === 0 ? 0 : dot(vector, doc.vector) / denom;
      hits.push({
        id,
        score,
        ...(doc.metadata !== undefined ? { metadata: doc.metadata } : {}),
      });
    }

    if (hits.length === 0) {
      this.#logger.debug("vector query against empty index");
    }

    hits.sort((a, b) => b.score - a.score);
    return Promise.resolve(hits.slice(0, k));
  }

  delete(id: string): Promise<void> {
    this.#docs.delete(id);
    return Promise.resolve();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }
}
