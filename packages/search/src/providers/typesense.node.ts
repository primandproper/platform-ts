import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";
import { Client, Errors } from "typesense";

import {
  DEFAULT_SEARCH_LIMIT,
  ID_KEY,
  INDEX_NAME_KEY,
  LENGTH_KEY,
  SEARCH_QUERY_KEY,
} from "../document-index.js";
import type { BulkTextIndex, TextDocument, TextHit, TextSearchOptions } from "../text.js";

/**
 * The Typesense document shape this provider stores. `text` is the searchable field;
 * `metadata` is serialized to JSON so arbitrary objects survive a round-trip without
 * forcing nested-field indexing on the collection.
 */
interface TypesenseTextDocument {
  id: string;
  text: string;
  metadata?: string;
}

export interface TypesenseTextOptions {
  /** Typesense API key. */
  apiKey: string;
  /** Connection host, e.g. `localhost`. */
  host: string;
  /** Connection port. */
  port: number;
  /** Connection protocol, `http` or `https`. */
  protocol: string;
  /** Collection that backs this index; created on first use if absent. */
  collection: string;
  /** Per-request connection timeout in seconds. */
  connectionTimeoutSeconds?: number;
}

/**
 * A {@link TextIndex} backed by a Typesense server. Documents are written into a single
 * collection whose `text` field is searched; the relevance `score` is Typesense's
 * `text_match`. The collection is created lazily on the first write or {@link ping}, so a
 * sync `provideTextIndex` can hand one back without awaiting I/O. Every SDK error is
 * rethrown wrapped with context; a delete of an unknown id is a no-op, and a miss is an
 * empty array rather than a sentinel.
 */
export class TypesenseTextIndex implements BulkTextIndex {
  readonly #client: Client;
  readonly #collection: string;
  readonly #observer: Observer;
  readonly #logger: Logger;
  #ensured: Promise<void> | undefined;

  constructor(options: TypesenseTextOptions, deps: ObservabilityDeps = {}) {
    this.#collection = options.collection;
    this.#observer = deps.observer ?? makeObserver(`search_${options.collection}`, deps);
    this.#logger = this.#observer.logger();
    this.#client = new Client({
      apiKey: options.apiKey,
      nodes: [
        {
          host: options.host,
          port: options.port,
          protocol: options.protocol,
        },
      ],
      ...(options.connectionTimeoutSeconds !== undefined
        ? { connectionTimeoutSeconds: options.connectionTimeoutSeconds }
        : {}),
    });
  }

  /** Creates the backing collection once, memoizing the in-flight promise. */
  #ensureCollection(): Promise<void> {
    return (this.#ensured ??= this.#createCollection());
  }

  #createCollection(): Promise<void> {
    return this.#observer.run("EnsureCollection", async (op) => {
      op.set(INDEX_NAME_KEY, this.#collection);

      try {
        const exists = await this.#client.collections(this.#collection).exists();
        if (exists) {
          return;
        }
        await this.#client.collections().create({
          name: this.#collection,
          fields: [
            { name: "id", type: "string" },
            { name: "text", type: "string" },
            { name: "metadata", type: "string", optional: true, index: false },
          ],
        });
      } catch (error) {
        // Another caller may have raced us to create it; tolerate that, surface the rest.
        if (error instanceof Errors.ObjectAlreadyExists) {
          return;
        }
        this.#ensured = undefined;
        throw op.error(error, "typesense ensure collection failed");
      }
    });
  }

  index(doc: TextDocument): Promise<void> {
    return this.#observer.run("Index", async (op) => {
      op.set(ID_KEY, doc.id).set(INDEX_NAME_KEY, this.#collection);
      await this.#ensureCollection();

      const document: TypesenseTextDocument = {
        id: doc.id,
        text: doc.text,
        ...(doc.metadata !== undefined ? { metadata: JSON.stringify(doc.metadata) } : {}),
      };

      this.#logger.debug("adding to index");

      try {
        await this.#client
          .collections<TypesenseTextDocument>(this.#collection)
          .documents()
          .upsert(document);
      } catch (error) {
        throw op.error(error, "typesense index failed");
      }
    });
  }

  indexMany(docs: readonly TextDocument[]): Promise<void> {
    return this.#observer.run("IndexMany", async (op) => {
      op.set(INDEX_NAME_KEY, this.#collection).set(LENGTH_KEY, docs.length);
      if (docs.length === 0) {
        return;
      }
      await this.#ensureCollection();

      const documents: TypesenseTextDocument[] = docs.map((doc) => ({
        id: doc.id,
        text: doc.text,
        ...(doc.metadata !== undefined ? { metadata: JSON.stringify(doc.metadata) } : {}),
      }));

      this.#logger.debug("bulk adding to index");

      try {
        // One `import` round trip instead of N upserts.
        await this.#client
          .collections<TypesenseTextDocument>(this.#collection)
          .documents()
          .import(documents, { action: "upsert" });
      } catch (error) {
        throw op.error(error, "typesense bulk index failed");
      }
    });
  }

  search(query: string, opts: TextSearchOptions = {}): Promise<TextHit[]> {
    return this.#observer.run("Search", async (op) => {
      op.set(SEARCH_QUERY_KEY, query).set(INDEX_NAME_KEY, this.#collection);
      await this.#ensureCollection();

      try {
        const response = await this.#client
          .collections<TypesenseTextDocument>(this.#collection)
          .documents()
          .search({
            q: query,
            query_by: "text",
            per_page: opts.limit ?? DEFAULT_SEARCH_LIMIT,
          });

        const hits = response.hits ?? [];
        const results = hits.map((hit) => toTextHit(hit.document, hit.text_match));
        op.set(LENGTH_KEY, results.length);
        this.#logger.debug("search performed");
        return results;
      } catch (error) {
        throw op.error(error, "typesense search failed");
      }
    });
  }

  delete(id: string): Promise<void> {
    return this.#observer.run("Delete", async (op) => {
      op.set(ID_KEY, id).set(INDEX_NAME_KEY, this.#collection);
      await this.#ensureCollection();

      try {
        await this.#client.collections(this.#collection).documents(id).delete();
      } catch (error) {
        // A miss is not an error: deleting an unknown id is a no-op.
        if (error instanceof Errors.ObjectNotFound) {
          return;
        }
        throw op.error(error, "typesense delete failed");
      }

      this.#logger.debug("removed from index");
    });
  }

  async ping(): Promise<void> {
    await this.#observer.run("Ping", async (op) => {
      op.set(INDEX_NAME_KEY, this.#collection);

      try {
        const health = await this.#client.health.retrieve();
        if (!health.ok) {
          throw new Error("typesense reported unhealthy");
        }
      } catch (error) {
        throw op.error(error, "typesense ping failed");
      }
    });
    await this.#ensureCollection();
  }
}

/** Maps a stored Typesense document back to a {@link TextHit}. */
function toTextHit(document: TypesenseTextDocument, score: number): TextHit {
  const metadata = parseMetadata(document.metadata);
  return {
    id: document.id,
    score,
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

/** Deserializes stored metadata, dropping it silently if it is not a JSON object. */
function parseMetadata(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Stored value was not valid JSON; treat as absent rather than throwing on read.
  }
  return undefined;
}
