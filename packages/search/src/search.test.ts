import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { MemoryTextIndex } from "./providers/memory-text.js";
import { MemoryVectorIndex } from "./providers/memory-vector.js";
import { NoopTextIndex, NoopVectorIndex } from "./providers/noop.js";
import { TypesenseTextIndex } from "./providers/typesense.node.js";

import {
  provideTextIndex,
  provideVectorIndex,
  type TextIndex,
  type VectorIndex,
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

describe("MemoryTextIndex", () => {
  it("ranks the most relevant document first", async () => {
    const index = new MemoryTextIndex();
    await seedText(index);

    const hits = await index.search("quick fox");
    expect(hits[0]?.id).toBe("c");
    expect(hits.map((h) => h.id)).toContain("a");
  });

  it("respects the limit", async () => {
    const index = new MemoryTextIndex();
    await seedText(index);

    const hits = await index.search("brown quick fox", { limit: 1 });
    expect(hits).toHaveLength(1);
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

async function seedVectors(index: VectorIndex): Promise<void> {
  await index.upsert({ id: "x", vector: [1, 0, 0] });
  await index.upsert({ id: "y", vector: [0, 1, 0] });
  await index.upsert({ id: "z", vector: [0.9, 0.1, 0] });
}

describe("MemoryVectorIndex", () => {
  it("ranks the nearest document by cosine first", async () => {
    const index = new MemoryVectorIndex();
    await seedVectors(index);

    const hits = await index.query([1, 0, 0], 3);
    expect(hits[0]?.id).toBe("x");
    expect(hits[1]?.id).toBe("z");
  });

  it("respects k", async () => {
    const index = new MemoryVectorIndex();
    await seedVectors(index);

    const hits = await index.query([1, 0, 0], 1);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe("x");
  });

  it("treats a zero-norm query as zero similarity", async () => {
    const index = new MemoryVectorIndex();
    await seedVectors(index);

    const hits = await index.query([0, 0, 0], 3);
    expect(hits.every((h) => h.score === 0)).toBe(true);
  });

  it("returns metadata on hits", async () => {
    const index = new MemoryVectorIndex();
    await index.upsert({ id: "x", vector: [1, 0], metadata: { tag: "x" } });

    const hits = await index.query([1, 0], 1);
    expect(hits[0]?.metadata).toEqual({ tag: "x" });
  });

  it("removes a document on delete", async () => {
    const index = new MemoryVectorIndex();
    await seedVectors(index);
    await index.delete("x");

    const hits = await index.query([1, 0, 0], 3);
    expect(hits.map((h) => h.id)).not.toContain("x");
  });

  it("throws on a dimension mismatch", async () => {
    const index = new MemoryVectorIndex();
    await index.upsert({ id: "x", vector: [1, 0, 0] });

    await expect(index.query([1, 0], 1)).rejects.toThrow(/dimension/);
  });

  it("pings without throwing", async () => {
    await expect(new MemoryVectorIndex().ping()).resolves.toBeUndefined();
  });
});

describe("NoopVectorIndex", () => {
  it("returns no hits", async () => {
    const index: VectorIndex = new NoopVectorIndex();
    await index.upsert({ id: "x", vector: [1, 0, 0] });
    expect(await index.query([1, 0, 0], 3)).toEqual([]);
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

describe("provideVectorIndex", () => {
  it("defaults to the memory provider", () => {
    expect(provideVectorIndex(undefined, {})).toBeInstanceOf(MemoryVectorIndex);
  });

  it("builds a noop provider", () => {
    expect(provideVectorIndex({ provider: "noop" })).toBeInstanceOf(NoopVectorIndex);
  });
});
