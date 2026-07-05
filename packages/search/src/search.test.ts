import { randomUUID } from "node:crypto";

import { makeRecordingObserver } from "@primandproper/observability";
import { describe, expect, it } from "vitest";

import { ID_KEY, INDEX_NAME_KEY, SEARCH_QUERY_KEY } from "./document-index.js";
import { isElasticNotFound } from "./providers/elasticsearch.node.js";
import { MemoryTextIndex } from "./providers/memory-text.js";
import { NoopTextIndex } from "./providers/noop.js";
import { TypesenseTextIndex } from "./providers/typesense.node.js";

import {
  DEFAULT_SEARCH_LIMIT,
  isBulkTextIndex,
  provideTextIndex,
  type TextIndex,
} from "./index.js";

/**
 * Live-Typesense integration is opt-in: set SEARCH_TEST_TYPESENSE_URL (e.g.
 * http://localhost:8108) and SEARCH_TEST_TYPESENSE_API_KEY to a reachable server to run the
 * text conformance suite against it. The default offline run skips it and stays green. Each
 * instance gets a unique collection so concurrent/leftover docs never collide.
 */
const TYPESENSE_URL = process.env.SEARCH_TEST_TYPESENSE_URL;
const TYPESENSE_API_KEY = process.env.SEARCH_TEST_TYPESENSE_API_KEY;

async function seedText(index: TextIndex): Promise<void> {
  await index.index({ id: "a", text: "the quick brown fox" });
  await index.index({ id: "b", text: "a lazy brown dog sleeps" });
  await index.index({ id: "c", text: "quick quick fox runs quick" });
}

/**
 * Provider-agnostic conformance suite. Running the same assertions against multiple providers
 * proves the `TextIndex` interface is implementation-independent. Real search engines rank by
 * their own scoring, so this asserts only behavior every backend must share — membership,
 * limits, metadata round-trips, deletes, and misses — not a specific ordering.
 */
function conformance(name: string, make: () => TextIndex): void {
  describe(name, () => {
    it("returns matching documents", async () => {
      const index = make();
      await seedText(index);

      const ids = (await index.search("quick fox")).map((h) => h.id);
      expect(ids).toContain("a");
      expect(ids).toContain("c");
    });

    it("respects the limit", async () => {
      const index = make();
      await seedText(index);

      const hits = await index.search("brown quick fox", { limit: 1 });
      expect(hits).toHaveLength(1);
    });

    it("returns metadata on hits", async () => {
      const index = make();
      await index.index({ id: "a", text: "brown fox", metadata: { tag: "x" } });

      const hits = await index.search("fox");
      expect(hits[0]?.metadata).toEqual({ tag: "x" });
    });

    it("removes a document on delete", async () => {
      const index = make();
      await seedText(index);
      await index.delete("c");

      const ids = (await index.search("quick fox")).map((h) => h.id);
      expect(ids).not.toContain("c");
    });

    it("deletes an unknown id as a no-op", async () => {
      const index = make();
      await expect(index.delete("missing")).resolves.toBeUndefined();
    });

    it("returns nothing for an unmatched query", async () => {
      const index = make();
      await seedText(index);

      expect(await index.search("elephant")).toEqual([]);
    });

    it("pings without throwing", async () => {
      await expect(make().ping()).resolves.toBeUndefined();
    });
  });
}

const typesenseIndex = (): TypesenseTextIndex => {
  const url = new URL(TYPESENSE_URL ?? "http://localhost:8108");
  return new TypesenseTextIndex({
    apiKey: TYPESENSE_API_KEY ?? "xyz",
    host: url.hostname,
    port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    protocol: url.protocol.replace(":", ""),
    collection: `searchtest_${randomUUID().replaceAll("-", "")}`,
  });
};

describe.skipIf(!TYPESENSE_URL || !TYPESENSE_API_KEY)("TypesenseTextIndex (live)", () => {
  conformance("TypesenseTextIndex", typesenseIndex);
});

/**
 * Instrumentation parity with the ElasticSearch/Algolia siblings (audit INST-2), asserted
 * offline: every I/O op opens an observer span, fans the index/id/query onto it, and routes a
 * failure through `op.error` so the error object itself is recorded. The point at an unreachable
 * server, so the first SDK call (the lazy collection ensure) fails and exercises the error path
 * without a live Typesense.
 */
describe("TypesenseTextIndex observability", () => {
  const offlineIndex = (
    observer: ReturnType<typeof makeRecordingObserver>,
  ): TypesenseTextIndex =>
    new TypesenseTextIndex(
      {
        apiKey: "xyz",
        host: "127.0.0.1",
        port: 59999,
        protocol: "http",
        collection: "obs_collection",
        connectionTimeoutSeconds: 1,
      },
      { observer },
    );

  it("opens an operation span with the id and index attributes", async () => {
    const observer = makeRecordingObserver();
    const index = offlineIndex(observer);

    await expect(index.index({ id: "doc-1", text: "hello" })).rejects.toBeDefined();

    expect(observer.forOperation("Index").length).toBeGreaterThan(0);
    expect(observer.data()[ID_KEY]).toBe("doc-1");
    expect(observer.data()[INDEX_NAME_KEY]).toBe("obs_collection");
  });

  it("records a failure with the error object and an error-outcome run", async () => {
    const observer = makeRecordingObserver();
    const index = offlineIndex(observer);

    await expect(index.index({ id: "doc-1", text: "hello" })).rejects.toBeDefined();

    // The dark-sibling bug was logging a bare string with neither the error nor an id; now the
    // failure is routed through op.error, capturing the error object itself.
    expect(observer.errors.length).toBeGreaterThan(0);
    expect(observer.errors[0]?.err).toBeDefined();
    expect(observer.errors.some((e) => e.description.includes("typesense"))).toBe(true);
    expect(observer.runs.some((r) => r.outcome === "error")).toBe(true);
  });

  it("observes the query on a failing search", async () => {
    const observer = makeRecordingObserver();
    const index = offlineIndex(observer);

    await expect(index.search("brown fox")).rejects.toBeDefined();

    expect(observer.forOperation("Search").length).toBeGreaterThan(0);
    expect(observer.data()[SEARCH_QUERY_KEY]).toBe("brown fox");
  });
});

describe("MemoryTextIndex", () => {
  it("ranks the most relevant document first", async () => {
    const index = new MemoryTextIndex();
    await seedText(index);

    const hits = await index.search("quick fox");
    expect(hits[0]?.id).toBe("c");
    expect(hits.map((h) => h.id)).toContain("a");
  });

  // PERF-5: the bulk seam indexes many docs and is discoverable via the guard.
  it("indexes many documents via the bulk seam", async () => {
    const index = new MemoryTextIndex();
    expect(isBulkTextIndex(index)).toBe(true);

    await index.indexMany([
      { id: "a", text: "the quick brown fox" },
      { id: "b", text: "a lazy dog" },
    ]);

    expect((await index.search("fox"))[0]?.id).toBe("a");
    expect((await index.search("dog"))[0]?.id).toBe("b");
  });

  it("respects the limit", async () => {
    const index = new MemoryTextIndex();
    await seedText(index);

    const hits = await index.search("brown quick fox", { limit: 1 });
    expect(hits).toHaveLength(1);
  });

  // SRCH-1: an omitted limit caps at DEFAULT_SEARCH_LIMIT, not "unbounded".
  it("caps results at the default limit when none is given", async () => {
    const index = new MemoryTextIndex();
    for (let i = 0; i < 25; i++) {
      await index.index({ id: `d${String(i)}`, text: "fox" });
    }

    expect(await index.search("fox")).toHaveLength(DEFAULT_SEARCH_LIMIT);
    // An explicit limit still overrides the default.
    expect(await index.search("fox", { limit: 3 })).toHaveLength(3);
  });

  it("returns metadata on hits", async () => {
    const index = new MemoryTextIndex();
    await index.index({ id: "a", text: "brown fox", metadata: { tag: "x" } });

    const hits = await index.search("fox");
    expect(hits[0]?.metadata).toEqual({ tag: "x" });
  });

  it("removes a document on delete", async () => {
    const index = new MemoryTextIndex();
    await seedText(index);
    await index.delete("c");

    const hits = await index.search("quick fox");
    expect(hits.map((h) => h.id)).not.toContain("c");
    expect(hits[0]?.id).toBe("a");
  });

  it("returns nothing for an unmatched query", async () => {
    const index = new MemoryTextIndex();
    await seedText(index);

    expect(await index.search("elephant")).toEqual([]);
  });

  it("pings without throwing", async () => {
    await expect(new MemoryTextIndex().ping()).resolves.toBeUndefined();
  });
});

describe("NoopTextIndex", () => {
  it("returns no hits", async () => {
    const index: TextIndex = new NoopTextIndex();
    await index.index({ id: "a", text: "brown fox" });
    expect(await index.search("fox")).toEqual([]);
  });
});

describe("provideTextIndex", () => {
  it("defaults to the memory provider", () => {
    expect(provideTextIndex(undefined, {})).toBeInstanceOf(MemoryTextIndex);
  });

  it("builds a noop provider", () => {
    expect(provideTextIndex({ provider: "noop" })).toBeInstanceOf(NoopTextIndex);
  });

  it("builds a typesense provider", () => {
    const index = provideTextIndex({
      provider: "typesense",
      typesense: { apiKey: "xyz" },
    });
    expect(index).toBeInstanceOf(TypesenseTextIndex);
  });

  it("rejects a typesense provider without its config", () => {
    expect(() => provideTextIndex({ provider: "typesense" })).toThrow(/typesense/);
  });
});

// SRCH-2: the Elasticsearch full flow is live-only, but its 404-detection (so a delete-of-missing
// is a no-op instead of tripping the circuit breaker) is pure and unit-testable.
describe("isElasticNotFound", () => {
  it("recognizes a 404 on statusCode or meta.statusCode", () => {
    expect(isElasticNotFound({ statusCode: 404 })).toBe(true);
    expect(isElasticNotFound({ meta: { statusCode: 404 } })).toBe(true);
  });

  it("is false for other statuses and non-errors", () => {
    expect(isElasticNotFound({ statusCode: 500 })).toBe(false);
    expect(isElasticNotFound({ meta: { statusCode: 503 } })).toBe(false);
    expect(isElasticNotFound(new Error("boom"))).toBe(false);
    expect(isElasticNotFound(undefined)).toBe(false);
    expect(isElasticNotFound(null)).toBe(false);
  });
});
