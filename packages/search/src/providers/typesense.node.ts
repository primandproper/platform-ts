import { wrap } from "@primandproper/errors";
import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";
import { Client, Errors } from "typesense";

import type { TextDocument, TextHit, TextIndex, TextSearchOptions } from "../text.js";

const o11yName = "search";

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
export class TypesenseTextIndex implements TextIndex {
  readonly #client: Client;
  readonly #collection: string;
  readonly #observer: Observer;
  readonly #logger: Logger;
  #ensured: Promise<void> | undefined;

  constructor(options: TypesenseTextOptions, deps: ObservabilityDeps = {}) {
    this.#collection = options.collection;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
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

  async #createCollection(): Promise<void> {
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
      this.#logger.error("typesense ensure collection failed");
      throw wrap("typesense ensure collection failed", error);
    }
  }

  async index(doc: TextDocument): Promise<void> {
    await this.#ensureCollection();

    const document: TypesenseTextDocument = {
      id: doc.id,
      text: doc.text,
      ...(doc.metadata !== undefined ? { metadata: JSON.stringify(doc.metadata) } : {}),
    };

    try {
      await this.#client
        .collections<TypesenseTextDocument>(this.#collection)
        .documents()
        .upsert(document);
    } catch (error) {
      this.#logger.error("typesense index failed");
      throw wrap(`typesense index failed for id ${doc.id}`, error);
    }
  }

  async search(query: string, opts: TextSearchOptions = {}): Promise<TextHit[]> {
    await this.#ensureCollection();

    try {
      const response = await this.#client
        .collections<TypesenseTextDocument>(this.#collection)
        .documents()
        .search({
          q: query,
          query_by: "text",
          ...(opts.limit !== undefined ? { per_page: opts.limit } : {}),
        });

      const hits = response.hits ?? [];
      return hits.map((hit) => toTextHit(hit.document, hit.text_match));
    } catch (error) {
      this.#logger.error("typesense search failed");
      throw wrap("typesense search failed", error);
    }
  }

  async delete(id: string): Promise<void> {
    await this.#ensureCollection();

    try {
      await this.#client.collections(this.#collection).documents(id).delete();
    } catch (error) {
      // A miss is not an error: deleting an unknown id is a no-op.
      if (error instanceof Errors.ObjectNotFound) {
        return;
      }
      this.#logger.error("typesense delete failed");
      throw wrap(`typesense delete failed for id ${id}`, error);
    }
  }

  async ping(): Promise<void> {
    try {
      const health = await this.#client.health.retrieve();
      if (!health.ok) {
        throw new Error("typesense reported unhealthy");
      }
    } catch (error) {
      throw wrap("typesense ping failed", error);
    }
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
