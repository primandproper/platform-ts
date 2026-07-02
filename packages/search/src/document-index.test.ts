import { randomUUID } from "node:crypto";

import type { CircuitBreaker } from "@primandproper/circuitbreaking";
import { isPlatformError } from "@primandproper/errors";
import { makeRecordingObserver } from "@primandproper/observability";
import { describe, expect, it, vi } from "vitest";

import {
  CircuitBrokenError,
  EmptyQueryError,
  SEARCH_QUERY_KEY,
  type DocumentIndex,
} from "./document-index.js";
import { AlgoliaDocumentIndex } from "./providers/algolia.node.js";
import { ElasticsearchDocumentIndex } from "./providers/elasticsearch.node.js";
import { NoopDocumentIndex } from "./providers/noop-document-index.js";

import { provideDocumentIndex } from "./index.js";

interface Doc {
  id: string;
  name: string;
}

/** A fake circuit breaker that records its calls and answers `canProceed` from a fixed value. */
function fakeBreaker(canProceed: boolean): CircuitBreaker & {
  canProceed: ReturnType<typeof vi.fn>;
  succeeded: ReturnType<typeof vi.fn>;
  failed: ReturnType<typeof vi.fn>;
} {
  return {
    canProceed: vi.fn(() => canProceed),
    succeeded: vi.fn(),
    failed: vi.fn(),
  };
}

/**
 * Provider-agnostic conformance: every backend must accept writes/deletes/wipes without
 * throwing and return a (possibly empty) array from search. Real engines rank by their own
 * scoring, so this asserts only the shared contract, run against the always-available noop.
 */
function conformance(name: string, make: () => DocumentIndex<Doc>): void {
  describe(name, () => {
    it("returns an array from search", async () => {
      const results = await make().search("anything");
      expect(Array.isArray(results)).toBe(true);
    });

    it("indexes, deletes, and wipes without throwing", async () => {
      const index = make();
      await expect(index.index("a", { id: "a", name: "first" })).resolves.toBeUndefined();
      await expect(index.delete("a")).resolves.toBeUndefined();
      await expect(index.wipe()).resolves.toBeUndefined();
    });
  });
}

conformance("NoopDocumentIndex", () => new NoopDocumentIndex<Doc>());

describe("provideDocumentIndex", () => {
  it("defaults to the noop provider", async () => {
    const index = await provideDocumentIndex<Doc>("test-index");
    expect(index).toBeInstanceOf(NoopDocumentIndex);
  });

  it("builds an algolia provider when configured", async () => {
    const index = await provideDocumentIndex<Doc>("test-index", {
      provider: "algolia",
      algolia: { appID: "app", apiKey: "key" },
    });
    expect(index).toBeInstanceOf(AlgoliaDocumentIndex);
  });

  it("rejects when algolia is selected without its config", async () => {
    await expect(provideDocumentIndex("test-index", { provider: "algolia" })).rejects.toThrow(
      /algolia/,
    );
  });

  it("rejects when elasticsearch is selected without its config", async () => {
    await expect(
      provideDocumentIndex("test-index", { provider: "elasticsearch" }),
    ).rejects.toThrow(/elasticsearch/);
  });
});

describe("circuit breaker guarding", () => {
  it("rejects every method with CircuitBrokenError when the breaker is open", async () => {
    const cb = fakeBreaker(false);
    const index = new AlgoliaDocumentIndex<Doc>(
      { appID: "app", apiKey: "key", indexName: "test" },
      cb,
    );

    await expect(index.index("a", { id: "a", name: "x" })).rejects.toBeInstanceOf(
      CircuitBrokenError,
    );
    await expect(index.search("q")).rejects.toBeInstanceOf(CircuitBrokenError);
    await expect(index.delete("a")).rejects.toBeInstanceOf(CircuitBrokenError);
    await expect(index.wipe()).rejects.toBeInstanceOf(CircuitBrokenError);

    // Open breaker: the SDK is never reached, so neither outcome is reported.
    expect(cb.succeeded).not.toHaveBeenCalled();
    expect(cb.failed).not.toHaveBeenCalled();
  });

  it("also guards algolia index (the fix over the Go source)", async () => {
    const cb = fakeBreaker(false);
    const index = new AlgoliaDocumentIndex<Doc>(
      { appID: "app", apiKey: "key", indexName: "test" },
      cb,
    );

    await expect(index.index("a", { id: "a", name: "x" })).rejects.toBeInstanceOf(
      CircuitBrokenError,
    );
    expect(cb.canProceed).toHaveBeenCalled();
  });
});

describe("query and observability", () => {
  it("rejects an empty query and still observes the query key", async () => {
    const observer = makeRecordingObserver();
    const index = new AlgoliaDocumentIndex<Doc>(
      { appID: "app", apiKey: "key", indexName: "test" },
      fakeBreaker(true),
      { observer },
    );

    await expect(index.search("")).rejects.toBeInstanceOf(EmptyQueryError);
    expect(observer.observed(SEARCH_QUERY_KEY)).toBe(true);
  });

  it("elasticsearch wipe is unimplemented", async () => {
    const index = new ElasticsearchDocumentIndex<Doc>(
      { address: "http://localhost:9200", indexName: "test", readinessAttempts: 1 },
      fakeBreaker(true),
    );

    const err: unknown = await index.wipe().catch((reason: unknown) => reason);
    expect(isPlatformError(err, "search/unimplemented")).toBe(true);
  });
});

/**
 * Live-Algolia integration is opt-in: set SEARCH_TEST_ALGOLIA_APP_ID and
 * SEARCH_TEST_ALGOLIA_API_KEY (a write-capable key) to a reachable app. Each run uses a unique
 * index so leftover documents never collide; the suite cleans up after itself.
 */
const ALGOLIA_APP_ID = process.env.SEARCH_TEST_ALGOLIA_APP_ID;
const ALGOLIA_API_KEY = process.env.SEARCH_TEST_ALGOLIA_API_KEY;

describe.skipIf(!ALGOLIA_APP_ID || !ALGOLIA_API_KEY)("algolia (live)", () => {
  it("round-trips a document and maps id<->objectID", async () => {
    const cb = fakeBreaker(true);
    const index = new AlgoliaDocumentIndex<Doc>(
      { appID: ALGOLIA_APP_ID!, apiKey: ALGOLIA_API_KEY!, indexName: `test-${randomUUID()}` },
      cb,
    );
    try {
      await index.index("doc-1", { id: "doc-1", name: "hello world" });
      // Algolia indexing is eventually consistent; a short wait keeps the test stable.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const results = await index.search("hello");
      expect(results.map((r) => r.id)).toContain("doc-1");
    } finally {
      await index.wipe();
    }
  });
});

/**
 * Live-Elasticsearch integration is opt-in: set SEARCH_TEST_ELASTICSEARCH_URL (e.g.
 * http://localhost:9200) to a reachable cluster. Exercises the real readiness/ensure/index/
 * search path through the factory.
 */
const ELASTICSEARCH_URL = process.env.SEARCH_TEST_ELASTICSEARCH_URL;

describe.skipIf(!ELASTICSEARCH_URL)("elasticsearch (live)", () => {
  it("indexes and searches through the factory", async () => {
    const index = await provideDocumentIndex<Doc>(`test-${randomUUID()}`, {
      provider: "elasticsearch",
      elasticsearch: { address: ELASTICSEARCH_URL! },
    });
    await index.index("doc-1", { id: "doc-1", name: "hello world" });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const results = await index.search("hello");
    expect(results.map((r) => r.id)).toContain("doc-1");
  });
});
