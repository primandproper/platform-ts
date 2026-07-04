import { provideCircuitBreaker } from "@primandproper/circuitbreaking";
import type { ObservabilityDeps } from "@primandproper/observability";

import {
  DocumentIndexConfigSchema,
  TextSearchConfigSchema,
  type DocumentIndexConfigInput,
  type TextSearchConfigInput,
} from "./config.js";
import type { DocumentIndex } from "./document-index.js";
import { AlgoliaDocumentIndex } from "./providers/algolia.node.js";
import { ElasticsearchDocumentIndex } from "./providers/elasticsearch.node.js";
import { MemoryTextIndex } from "./providers/memory-text.js";
import { NoopDocumentIndex } from "./providers/noop-document-index.js";
import { NoopTextIndex } from "./providers/noop.js";
import { TypesenseTextIndex } from "./providers/typesense.node.js";
import type { TextIndex } from "./text.js";

export * from "./text.js";
export * from "./document-index.js";
export * from "./config.js";
export { MemoryTextIndex } from "./providers/memory-text.js";
export { NoopTextIndex } from "./providers/noop.js";
export { NoopDocumentIndex } from "./providers/noop-document-index.js";
export {
  AlgoliaDocumentIndex,
  type AlgoliaDocumentIndexOptions,
} from "./providers/algolia.node.js";
export {
  ElasticsearchDocumentIndex,
  type ElasticsearchDocumentIndexOptions,
} from "./providers/elasticsearch.node.js";
export {
  TypesenseTextIndex,
  type TypesenseTextOptions,
} from "./providers/typesense.node.js";

/**
 * Validates config and returns the matching {@link TextIndex}. Mirrors the Go platform's
 * `Provide*`. Supports `memory` (default), `noop`, and `typesense`.
 */
export function provideTextIndex(
  config?: TextSearchConfigInput,
  deps?: ObservabilityDeps,
): TextIndex {
  const cfg = TextSearchConfigSchema.parse(config ?? {});
  switch (cfg.provider) {
    case "memory":
      return new MemoryTextIndex(deps);
    case "noop":
      return new NoopTextIndex();
    case "typesense":
      // superRefine guarantees this, but narrow for the type checker.
      if (cfg.typesense === undefined) {
        throw new Error("typesense config is required when provider is 'typesense'");
      }
      return new TypesenseTextIndex(
        {
          apiKey: cfg.typesense.apiKey,
          host: cfg.typesense.host,
          port: cfg.typesense.port,
          protocol: cfg.typesense.protocol,
          collection: cfg.typesense.collection,
          connectionTimeoutSeconds: cfg.typesense.connectionTimeoutSeconds,
        },
        deps,
      );
  }
}

/**
 * Validates config and returns the matching generic {@link DocumentIndex}. The faithful port of
 * platform-go's `textsearch.ProvideIndex[T]`: defaults to `noop`, builds the circuit breaker
 * that wraps every provider call, and is async because the `elasticsearch` provider polls the
 * cluster for readiness and ensures its index before returning. `indexName` names the backing
 * index (and the per-index observer, `search_<indexName>`).
 */
export async function provideDocumentIndex<T>(
  indexName: string,
  config?: DocumentIndexConfigInput,
  deps?: ObservabilityDeps,
): Promise<DocumentIndex<T>> {
  const cfg = DocumentIndexConfigSchema.parse(config ?? {});
  const circuitBreaker = provideCircuitBreaker(cfg.circuitBreaker, deps);
  switch (cfg.provider) {
    case "algolia":
      // superRefine guarantees this, but narrow for the type checker.
      if (cfg.algolia === undefined) {
        throw new Error("algolia config is required when provider is 'algolia'");
      }
      return new AlgoliaDocumentIndex<T>(
        { appID: cfg.algolia.appID, apiKey: cfg.algolia.apiKey, indexName },
        circuitBreaker,
        deps,
      );
    case "elasticsearch":
      if (cfg.elasticsearch === undefined) {
        throw new Error("elasticsearch config is required when provider is 'elasticsearch'");
      }
      return ElasticsearchDocumentIndex.create<T>(
        {
          address: cfg.elasticsearch.address,
          username: cfg.elasticsearch.username,
          password: cfg.elasticsearch.password,
          ...(cfg.elasticsearch.caCert !== undefined
            ? { caCert: cfg.elasticsearch.caCert }
            : {}),
          ...(cfg.elasticsearch.indexOperationTimeoutMs !== undefined
            ? { indexOperationTimeoutMs: cfg.elasticsearch.indexOperationTimeoutMs }
            : {}),
          indexName,
          readinessAttempts: cfg.elasticsearch.readinessAttempts,
        },
        circuitBreaker,
        deps,
      );
    case "noop":
      return new NoopDocumentIndex<T>();
  }
}
