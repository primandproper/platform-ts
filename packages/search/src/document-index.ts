import { PlatformError } from "@primandproper/errors";

/**
 * The read half of a document index: full-text query returning the decoded documents (not
 * scored hits). Generic over the stored document type `T`. Port of platform-go's
 * `textsearch.IndexSearcher[T]`.
 */
export interface IndexSearcher<T> {
  /** Returns the documents matching `query`. A miss is an empty array, never a sentinel. */
  search(query: string): Promise<T[]>;
}

/**
 * The write/admin half of a document index. Not generic — `index` takes an arbitrary
 * serializable `value`, mirroring Go's `Index(ctx, id, value any)`. Port of
 * platform-go's `textsearch.IndexManager`.
 */
export interface IndexManager {
  /** Indexes (or replaces) `value` under `id`. */
  index(id: string, value: unknown): Promise<void>;
  /** Removes a document by id. */
  delete(id: string): Promise<void>;
  /** Clears the entire index. */
  wipe(): Promise<void>;
}

/**
 * A generic, provider-swappable text search index combining {@link IndexSearcher} and
 * {@link IndexManager}. The faithful TypeScript port of platform-go's `textsearch.Index[T]`,
 * distinct from this package's `TextIndex`: it indexes whole objects, returns decoded
 * documents of type `T`, and exposes `wipe()` rather than scored hits.
 */
export interface DocumentIndex<T> extends IndexSearcher<T>, IndexManager {}

/**
 * The message published onto the indexing queue for a row that needs (re)indexing. Port of
 * platform-go's `textsearch.IndexRequest`; the JSON shape is preserved exactly so it stays
 * wire-compatible with the Go scheduler/worker.
 */
export interface IndexRequest {
  /** Request identifier (`id`); assigned by the publisher when omitted. */
  id?: string;
  /** The row to index (`rowID`). */
  rowID: string;
  /** The index type this row belongs to (`type`). */
  type: string;
  /** Optional test correlation id (`testID`); omitted when empty. */
  testID?: string;
  /** Whether this request removes the row from the index rather than upserting it. */
  delete: boolean;
}

/** The query-param key carrying the search text in HTTP requests. Port of `QueryKeySearch`. */
export const QUERY_KEY_SEARCH = "q";

/**
 * Observability keys the providers attach to spans/logs, matching platform-go's
 * `observability/keys` so traces line up across the two platforms.
 */
export const SEARCH_QUERY_KEY = "search_query";
export const INDEX_NAME_KEY = "index.name";
export const LENGTH_KEY = "length";
export const ID_KEY = "id";

/** Thrown when an empty search query is provided. Port of `ErrEmptyQueryProvided`. */
export class EmptyQueryError extends PlatformError {
  constructor() {
    super("search/empty-query", "empty search query provided");
    this.name = "EmptyQueryError";
  }
}

/**
 * Thrown when the circuit breaker is open and rejects a call. Replaces platform-go's
 * `circuitbreaking.ErrCircuitBroken`, which our `@primandproper/circuitbreaking` package does
 * not export as a sentinel.
 */
export class CircuitBrokenError extends PlatformError {
  constructor() {
    super("search/circuit-broken", "service circuit broken");
    this.name = "CircuitBrokenError";
  }
}
