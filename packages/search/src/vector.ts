/** A document to index for vector (nearest-neighbour) search. */
export interface VectorDocument {
  id: string;
  vector: number[];
  metadata?: Record<string, unknown>;
}

/** A single ranked result from a vector query, ordered by descending {@link VectorHit.score}. */
export interface VectorHit {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

/**
 * The vector search contract. {@link VectorIndex.query} ranks by similarity; a miss is an empty
 * array rather than a sentinel error, mirroring {@link import("./text.js").TextIndex}.
 */
export interface VectorIndex {
  /** Inserts (or replaces) a document by id. */
  upsert(doc: VectorDocument): Promise<void>;
  /** Returns the `k` nearest documents to `vector`, sorted by descending similarity. */
  query(vector: number[], k: number): Promise<VectorHit[]>;
  /** Removes a document by id. A no-op when the id is unknown. */
  delete(id: string): Promise<void>;
  /** Verifies the backing store is reachable. */
  ping(): Promise<void>;
}
