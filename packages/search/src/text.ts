/** A document to index for full-text search. */
export interface TextDocument {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

/** A single ranked result from a text search, ordered by descending {@link TextHit.score}. */
export interface TextHit {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

/** Options for {@link TextIndex.search}. */
export interface TextSearchOptions {
  /** Maximum number of hits to return. Unbounded when omitted. */
  limit?: number;
}

/**
 * The full-text search contract. A miss is an empty array rather than a sentinel error — the
 * same idiomatic-TypeScript divergence the cache makes from Go's `(value, error)`.
 */
export interface TextIndex {
  /** Indexes (or replaces) a document by id. */
  index(doc: TextDocument): Promise<void>;
  /** Returns hits matching the query, sorted by descending score and limited. */
  search(query: string, opts?: TextSearchOptions): Promise<TextHit[]>;
  /** Removes a document by id. A no-op when the id is unknown. */
  delete(id: string): Promise<void>;
  /** Verifies the backing store is reachable. */
  ping(): Promise<void>;
}
