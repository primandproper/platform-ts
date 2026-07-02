import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type { TextDocument, TextHit, TextIndex, TextSearchOptions } from "../text.js";

const o11yName = "search";

interface StoredTextDocument {
  readonly text: string;
  readonly terms: Map<string, number>;
  readonly metadata?: Record<string, unknown>;
}

const WORD = /[a-z0-9]+/g;

function tokenize(text: string): string[] {
  return text.toLowerCase().match(WORD) ?? [];
}

function termFrequencies(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/**
 * An in-memory {@link TextIndex}. Scores documents by query-term overlap weighted by term
 * frequency — genuinely usable for small datasets and tests, not a production search engine.
 * The default text provider.
 */
export class MemoryTextIndex implements TextIndex {
  readonly #docs = new Map<string, StoredTextDocument>();
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(deps: ObservabilityDeps = {}) {
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  index(doc: TextDocument): Promise<void> {
    const stored: StoredTextDocument = {
      text: doc.text,
      terms: termFrequencies(tokenize(doc.text)),
      ...(doc.metadata !== undefined ? { metadata: doc.metadata } : {}),
    };
    this.#docs.set(doc.id, stored);
    return Promise.resolve();
  }

  search(query: string, opts: TextSearchOptions = {}): Promise<TextHit[]> {
    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) {
      this.#logger.debug("empty text query");
      return Promise.resolve([]);
    }

    const hits: TextHit[] = [];
    for (const [id, doc] of this.#docs) {
      let score = 0;
      for (const term of queryTerms) {
        score += doc.terms.get(term) ?? 0;
      }
      if (score > 0) {
        hits.push({
          id,
          score,
          ...(doc.metadata !== undefined ? { metadata: doc.metadata } : {}),
        });
      }
    }

    hits.sort((a, b) => b.score - a.score);

    const limit = opts.limit;
    return Promise.resolve(limit !== undefined ? hits.slice(0, limit) : hits);
  }

  delete(id: string): Promise<void> {
    this.#docs.delete(id);
    return Promise.resolve();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }
}
