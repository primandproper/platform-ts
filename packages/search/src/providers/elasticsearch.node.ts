import { Client, type ClientOptions } from "@elastic/elasticsearch";
import type { CircuitBreaker } from "@primandproper/circuitbreaking";
import { PlatformError, wrap } from "@primandproper/errors";
import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import {
  type BulkDocument,
  type BulkIndexManager,
  CircuitBrokenError,
  DEFAULT_SEARCH_LIMIT,
  EmptyQueryError,
  ID_KEY,
  INDEX_NAME_KEY,
  LENGTH_KEY,
  SEARCH_QUERY_KEY,
  type DocumentIndex,
} from "../document-index.js";

export interface ElasticsearchDocumentIndexOptions {
  /** Node address, e.g. `http://localhost:9200`. */
  address: string;
  /** Basic-auth username; omit/empty for none. */
  username?: string;
  /** Basic-auth password; omit/empty for none. */
  password?: string;
  /** PEM CA certificate for TLS verification. */
  caCert?: string;
  /** Per-index-operation timeout in milliseconds. */
  indexOperationTimeoutMs?: number;
  /** The index this manager reads and writes. */
  indexName: string;
  /** How many times to poll the cluster for readiness before giving up. */
  readinessAttempts: number;
}

/** Minimal shape of the Elasticsearch search response we decode. Port of `queries.go`. */
interface SearchResponseBody<T> {
  hits?: {
    hits?: { _id?: string; _source?: T }[];
  };
}

/**
 * A {@link DocumentIndex} backed by Elasticsearch. Port of platform-go's elasticsearch
 * provider. Construct via {@link ElasticsearchDocumentIndex.create}, which polls the cluster
 * for readiness and ensures the backing index exists before returning. Every external call is
 * circuit-breaker–guarded and wrapped with context on failure.
 *
 * Two deliberate divergences from the Go source: `search` issues a real `query_string` query
 * (the Go version built an empty `bool/should` that matched nothing), and `wipe` throws an
 * explicit unimplemented error (as the Go version also did).
 */
export class ElasticsearchDocumentIndex<T> implements DocumentIndex<T>, BulkIndexManager {
  readonly #client: Client;
  readonly #indexName: string;
  readonly #indexOperationTimeoutMs: number | undefined;
  readonly #cb: CircuitBreaker;
  readonly #observer: Observer;
  readonly #logger: Logger;

  /**
   * Builds the client and observer without any I/O — the `new Client(...)` connection is lazy.
   * Prefer {@link ElasticsearchDocumentIndex.create}, which also waits for readiness and ensures
   * the index; use the constructor directly only when you want to skip that handshake (e.g. tests).
   */
  constructor(
    options: ElasticsearchDocumentIndexOptions,
    circuitBreaker: CircuitBreaker,
    deps: ObservabilityDeps = {},
  ) {
    // Elasticsearch lowercases index names; normalize once so exists/create/index/search/delete
    // all address the same index (they previously mixed the raw and lowercased name).
    this.#indexName = options.indexName.toLowerCase();
    this.#indexOperationTimeoutMs = options.indexOperationTimeoutMs;
    this.#cb = circuitBreaker;
    this.#observer = deps.observer ?? makeObserver(`search_${options.indexName}`, deps);
    this.#logger = this.#observer.logger();
    this.#client = new Client(buildClientOptions(options));
  }

  /**
   * Builds the index, waits for the cluster to become reachable, ensures the index exists, and
   * returns the ready-to-use manager. Mirrors Go's `ProvideIndexManager` (readiness poll +
   * `ensureIndices`).
   */
  static async create<T>(
    options: ElasticsearchDocumentIndexOptions,
    circuitBreaker: CircuitBreaker,
    deps: ObservabilityDeps = {},
  ): Promise<ElasticsearchDocumentIndex<T>> {
    const index = new ElasticsearchDocumentIndex<T>(options, circuitBreaker, deps);
    await index.#awaitReady(options.readinessAttempts);
    await index.#ensureIndices();
    return index;
  }

  async #awaitReady(maxAttempts: number): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.#client.info();
        return;
      } catch (error) {
        if (attempt >= maxAttempts) {
          throw wrap("elasticsearch not ready", error);
        }
        this.#logger.debug("ping failed, waiting for elasticsearch");
        await delay(1_000);
      }
    }
  }

  #ensureIndices(): Promise<void> {
    return this.#observer.run("EnsureIndices", async (op) => {
      op.set(INDEX_NAME_KEY, this.#indexName);

      if (!this.#cb.canProceed()) {
        throw new CircuitBrokenError();
      }

      try {
        const exists = await this.#client.indices.exists({ index: this.#indexName });
        if (!exists) {
          await this.#client.indices.create({ index: this.#indexName });
        }
        this.#cb.succeeded();
      } catch (error) {
        this.#cb.failed();
        throw wrap("checking index existence", error);
      }
    });
  }

  index(id: string, value: unknown): Promise<void> {
    return this.#observer.run("Index", async (op) => {
      if (!this.#cb.canProceed()) {
        throw new CircuitBrokenError();
      }

      op.set(ID_KEY, id).set(INDEX_NAME_KEY, this.#indexName);
      this.#logger.debug("adding to index");

      try {
        await this.#client.index({
          index: this.#indexName,
          id,
          document: value as Record<string, unknown>,
          ...(this.#indexOperationTimeoutMs !== undefined
            ? { timeout: `${String(this.#indexOperationTimeoutMs)}ms` }
            : {}),
        });
        this.#cb.succeeded();
      } catch (error) {
        this.#cb.failed();
        throw wrap("indexing value", error);
      }
    });
  }

  indexMany(documents: readonly BulkDocument[]): Promise<void> {
    return this.#observer.run("IndexMany", async (op) => {
      if (documents.length === 0) {
        return;
      }
      if (!this.#cb.canProceed()) {
        throw new CircuitBrokenError();
      }

      op.set(INDEX_NAME_KEY, this.#indexName).set(LENGTH_KEY, documents.length);
      this.#logger.debug("bulk adding to index");

      // One `_bulk` round trip: an action line + a source line per document.
      const operations = documents.flatMap(({ id, value }) => [
        { index: { _index: this.#indexName, _id: id } },
        value as Record<string, unknown>,
      ]);

      try {
        const response = await this.#client.bulk({
          operations,
          ...(this.#indexOperationTimeoutMs !== undefined
            ? { timeout: `${String(this.#indexOperationTimeoutMs)}ms` }
            : {}),
        });
        if (response.errors) {
          throw new PlatformError(
            "search/bulk-failed",
            "elasticsearch bulk had item errors",
          );
        }
        this.#cb.succeeded();
      } catch (error) {
        this.#cb.failed();
        throw wrap("bulk indexing values", error);
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

      let body: SearchResponseBody<T>;
      try {
        body = await this.#client.search<T>({
          index: this.#indexName,
          query: { query_string: { query } },
          // Cap the result set explicitly; ES otherwise silently returns its own default of 10.
          size: DEFAULT_SEARCH_LIMIT,
        });
        this.#cb.succeeded();
      } catch (error) {
        this.#cb.failed();
        throw wrap("querying elasticsearch", error);
      }

      const results: T[] = [];
      for (const hit of body.hits?.hits ?? []) {
        if (hit._source !== undefined) {
          results.push(hit._source);
        }
      }

      op.set(INDEX_NAME_KEY, this.#indexName).set(LENGTH_KEY, results.length);
      return results;
    });
  }

  delete(id: string): Promise<void> {
    return this.#observer.run("Delete", async (op) => {
      if (!this.#cb.canProceed()) {
        throw new CircuitBrokenError();
      }

      op.set(ID_KEY, id).set(INDEX_NAME_KEY, this.#indexName);

      try {
        await this.#client.delete({ index: this.#indexName, id });
        this.#cb.succeeded();
      } catch (error) {
        // Deleting an unknown id is a no-op, not a failure — the server responded, so this must
        // not trip the breaker (matches the Typesense sibling's ObjectNotFound handling).
        if (isElasticNotFound(error)) {
          this.#cb.succeeded();
          this.#logger.debug("delete of missing document is a no-op");
          return;
        }
        this.#cb.failed();
        throw wrap("deleting from elasticsearch", error);
      }

      this.#logger.debug("removed from index");
    });
  }

  wipe(): Promise<void> {
    return Promise.reject(
      new PlatformError("search/unimplemented", "wipe is unimplemented"),
    );
  }
}

function buildClientOptions(options: ElasticsearchDocumentIndexOptions): ClientOptions {
  const clientOptions: ClientOptions = { node: options.address, maxRetries: 10 };
  if (options.username || options.password) {
    clientOptions.auth = {
      username: options.username ?? "",
      password: options.password ?? "",
    };
  }
  if (options.caCert !== undefined) {
    clientOptions.tls = { ca: options.caCert };
  }
  return clientOptions;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether an error from the Elasticsearch client represents a 404 (index or document not found).
 * The client raises a `ResponseError` carrying the HTTP status on `statusCode` (and `meta.statusCode`).
 */
export function isElasticNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  const metaStatusCode = (error as { meta?: { statusCode?: unknown } }).meta?.statusCode;
  return statusCode === 404 || metaStatusCode === 404;
}
