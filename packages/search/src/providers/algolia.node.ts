import type { CircuitBreaker } from "@primandproper/circuitbreaking";
import { wrap } from "@primandproper/errors";
import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";
import { algoliasearch, type Algoliasearch } from "algoliasearch";

import {
  CircuitBrokenError,
  EmptyQueryError,
  ID_KEY,
  LENGTH_KEY,
  SEARCH_QUERY_KEY,
  type DocumentIndex,
} from "../document-index.js";

const OBJECT_ID_KEY = "objectID";

export interface AlgoliaDocumentIndexOptions {
  /** Algolia application id. */
  appID: string;
  /** Algolia write-capable API key. */
  apiKey: string;
  /** The index this manager reads and writes. */
  indexName: string;
}

/**
 * A {@link DocumentIndex} backed by Algolia. Port of platform-go's algolia provider. Documents
 * are keyed by Algolia's `objectID`, so on write the document's `id` is mapped to `objectID`
 * and on read it is mapped back — keeping the `id`-centric contract callers expect. Every call
 * is guarded by the circuit breaker (including `index`, which the Go source omitted — fixed
 * here) and wrapped with context on failure.
 */
export class AlgoliaDocumentIndex<T> implements DocumentIndex<T> {
  readonly #client: Algoliasearch;
  readonly #indexName: string;
  readonly #cb: CircuitBreaker;
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(
    options: AlgoliaDocumentIndexOptions,
    circuitBreaker: CircuitBreaker,
    deps: ObservabilityDeps = {},
  ) {
    this.#indexName = options.indexName;
    this.#cb = circuitBreaker;
    this.#observer = deps.observer ?? makeObserver(`search_${options.indexName}`, deps);
    this.#logger = this.#observer.logger();
    this.#client = algoliasearch(options.appID, options.apiKey);
  }

  index(id: string, value: unknown): Promise<void> {
    return this.#observer.run("Index", async (op) => {
      if (!this.#cb.canProceed()) {
        throw new CircuitBrokenError();
      }

      op.set(ID_KEY, id);
      this.#logger.debug("adding to index");

      const record = toRecord(value);
      // Algolia keys documents by objectID; the platform keys by id.
      record[OBJECT_ID_KEY] = id;
      delete record.id;

      try {
        await this.#client.saveObject({ indexName: this.#indexName, body: record });
        this.#cb.succeeded();
      } catch (error) {
        this.#cb.failed();
        throw wrap(`algolia index failed for id ${id}`, error);
      }
    });
  }

  search(query: string): Promise<T[]> {
    return this.#observer.run("Search", async (op) => {
      if (!this.#cb.canProceed()) {
        throw new CircuitBrokenError();
      }

      op.set(SEARCH_QUERY_KEY, query);

      if (query === "") {
        throw new EmptyQueryError();
      }

      let hits: Record<string, unknown>[];
      try {
        const response = await this.#client.searchSingleIndex({
          indexName: this.#indexName,
          searchParams: { query },
        });
        hits = response.hits;
        this.#cb.succeeded();
      } catch (error) {
        this.#cb.failed();
        throw wrap("algolia search failed", error);
      }

      const results = hits.map(restoreId) as T[];
      op.set(LENGTH_KEY, results.length);
      this.#logger.debug("search performed");
      return results;
    });
  }

  delete(id: string): Promise<void> {
    return this.#observer.run("Delete", async (op) => {
      if (!this.#cb.canProceed()) {
        throw new CircuitBrokenError();
      }

      op.set(ID_KEY, id);

      try {
        await this.#client.deleteObject({ indexName: this.#indexName, objectID: id });
        this.#cb.succeeded();
      } catch (error) {
        this.#cb.failed();
        throw wrap(`algolia delete failed for id ${id}`, error);
      }

      this.#logger.debug("removed from index");
    });
  }

  wipe(): Promise<void> {
    return this.#observer.run("Wipe", async () => {
      if (!this.#cb.canProceed()) {
        throw new CircuitBrokenError();
      }

      try {
        await this.#client.clearObjects({ indexName: this.#indexName });
        this.#cb.succeeded();
      } catch (error) {
        this.#cb.failed();
        throw wrap("algolia wipe failed", error);
      }
    });
  }
}

/** JSON round-trips `value` into a mutable string-keyed record, mirroring Go's marshal/unmarshal. */
function toRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

/** Restores an Algolia hit's `objectID` back to the platform's `id` field. */
function restoreId(hit: Record<string, unknown>): Record<string, unknown> {
  const { [OBJECT_ID_KEY]: objectID, ...rest } = hit;
  if (objectID !== undefined) {
    rest.id = objectID;
  }
  return rest;
}
