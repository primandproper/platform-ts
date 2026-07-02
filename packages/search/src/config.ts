import { CircuitBreakerConfigSchema } from "@primandproper/circuitbreaking";
import { z } from "zod";

/** Typesense-provider config: connects to a Typesense server over HTTP with an API key. */
export const TypesenseTextConfigSchema = z.object({
  apiKey: z.string(),
  host: z.string().default("localhost"),
  port: z.number().int().positive().default(8108),
  protocol: z.enum(["http", "https"]).default("http"),
  /** Collection that backs the index; created on first use if absent. */
  collection: z.string().default("text"),
  /** Per-request connection timeout in seconds. */
  connectionTimeoutSeconds: z.number().int().positive().default(10),
});

export type TypesenseTextConfig = z.infer<typeof TypesenseTextConfigSchema>;

/**
 * Text search config. Replaces the Go `env:`-tagged struct + ozzo `ValidateWithContext`.
 * `memory` (default) keeps an in-process inverted index; `noop` indexes nothing;
 * `typesense` delegates to a running Typesense server. Elasticsearch/OpenSearch is
 * documented as a future provider — it needs a provider SDK and a running server and stays
 * server-side.
 */
export const TextSearchConfigSchema = z
  .object({
    provider: z.enum(["memory", "noop", "typesense"]).default("memory"),
    typesense: TypesenseTextConfigSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.provider === "typesense" && cfg.typesense === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["typesense"],
        message: "typesense config is required when provider is 'typesense'",
      });
    }
  });

export type TextSearchConfig = z.infer<typeof TextSearchConfigSchema>;
export type TextSearchConfigInput = z.input<typeof TextSearchConfigSchema>;

/**
 * Vector search config. `memory` (default) keeps in-process vectors and ranks by cosine
 * similarity; `noop` indexes nothing. pgvector and Pinecone are documented as future
 * providers — they need provider SDKs or a database connection and stay server-side.
 */
export const VectorSearchConfigSchema = z.object({
  provider: z.enum(["memory", "noop"]).default("memory"),
});

export type VectorSearchConfig = z.infer<typeof VectorSearchConfigSchema>;
export type VectorSearchConfigInput = z.input<typeof VectorSearchConfigSchema>;

/** Algolia-provider config for the generic {@link import("./document-index.js").DocumentIndex}. */
export const AlgoliaConfigSchema = z.object({
  /** Algolia application id. */
  appID: z.string(),
  /** Algolia write-capable API key. */
  apiKey: z.string(),
});

export type AlgoliaConfig = z.infer<typeof AlgoliaConfigSchema>;

/** Elasticsearch-provider config for the generic {@link import("./document-index.js").DocumentIndex}. */
export const ElasticsearchConfigSchema = z.object({
  /** Node address, e.g. `http://localhost:9200`. */
  address: z.string(),
  username: z.string().default(""),
  password: z.string().default(""),
  /** PEM CA certificate for TLS verification. */
  caCert: z.string().optional(),
  /** Per-index-operation timeout in milliseconds. */
  indexOperationTimeoutMs: z.number().int().positive().optional(),
  /** Readiness-poll attempts before the factory gives up. */
  readinessAttempts: z.number().int().positive().default(10),
});

export type ElasticsearchConfig = z.infer<typeof ElasticsearchConfigSchema>;

/**
 * Config for the generic {@link import("./document-index.js").DocumentIndex} surface — the
 * faithful port of platform-go's `textsearch` config. `noop` (default, matching Go's fallback)
 * indexes nothing; `algolia` and `elasticsearch` delegate to their server-side backends. The
 * embedded circuit-breaker config wraps every provider call.
 */
export const DocumentIndexConfigSchema = z
  .object({
    provider: z.enum(["algolia", "elasticsearch", "noop"]).default("noop"),
    algolia: AlgoliaConfigSchema.optional(),
    elasticsearch: ElasticsearchConfigSchema.optional(),
    circuitBreaker: CircuitBreakerConfigSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.provider === "algolia" && cfg.algolia === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["algolia"],
        message: "algolia config is required when provider is 'algolia'",
      });
    }
    if (cfg.provider === "elasticsearch" && cfg.elasticsearch === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["elasticsearch"],
        message: "elasticsearch config is required when provider is 'elasticsearch'",
      });
    }
  });

export type DocumentIndexConfig = z.infer<typeof DocumentIndexConfigSchema>;
export type DocumentIndexConfigInput = z.input<typeof DocumentIndexConfigSchema>;
