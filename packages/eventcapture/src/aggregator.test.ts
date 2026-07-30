import { describe, expect, it } from "vitest";

import { Aggregator } from "./aggregator.js";

const MINUTE = 60_000;

/** Folds an integer count, the shape most aggregations start as. */
const increment = (current: number | undefined): number => (current ?? 0) + 1;

describe("Aggregator", () => {
  it("folds observations into per-(key, window) cells", () => {
    const agg = new Aggregator<string, number>({ bucketMs: MINUTE });
    const at = new Date("2026-07-30T12:00:30Z");

    agg.observe("a", at, increment);
    agg.observe("a", new Date("2026-07-30T12:00:59Z"), increment);
    agg.observe("b", at, increment);
    expect(agg.size).toBe(2);

    const buckets = agg.flush(new Date("2026-07-30T12:01:00Z"), false);
    expect(buckets).toHaveLength(2);
    expect(buckets.map((b) => [b.key, b.counts])).toEqual(
      expect.arrayContaining([
        ["a", 2],
        ["b", 1],
      ]),
    );
    expect(buckets[0]?.start.toISOString()).toBe("2026-07-30T12:00:00.000Z");
    expect(buckets[0]?.sizeMs).toBe(MINUTE);
    // Flushed cells are removed, so the next flush cannot double-count them.
    expect(agg.size).toBe(0);
  });

  it("separates windows for the same key", () => {
    const agg = new Aggregator<string, number>({ bucketMs: MINUTE });
    agg.observe("a", new Date("2026-07-30T12:00:10Z"), increment);
    agg.observe("a", new Date("2026-07-30T12:01:10Z"), increment);
    expect(agg.size).toBe(2);
  });

  it("holds back windows that have not closed yet", () => {
    const agg = new Aggregator<string, number>({ bucketMs: MINUTE });
    agg.observe("a", new Date("2026-07-30T12:00:10Z"), increment);

    expect(agg.flush(new Date("2026-07-30T12:00:59Z"), false)).toHaveLength(0);
    expect(agg.size).toBe(1);
    expect(agg.flush(new Date("2026-07-30T12:01:00Z"), false)).toHaveLength(1);
  });

  it("emits every bucket when asked for all of them — the drain path", () => {
    const agg = new Aggregator<string, number>({ bucketMs: MINUTE });
    agg.observe("a", new Date("2026-07-30T12:00:10Z"), increment);

    expect(agg.flush(new Date("2026-07-30T12:00:11Z"), true)).toHaveLength(1);
    expect(agg.size).toBe(0);
  });

  it("drops and counts observations past the key bound", () => {
    const agg = new Aggregator<string, number>({ bucketMs: MINUTE, maxKeys: 2 });
    const at = new Date("2026-07-30T12:00:00Z");

    agg.observe("a", at, increment);
    agg.observe("b", at, increment);
    agg.observe("c", at, increment);
    agg.observe("d", at, increment);
    // An existing cell is still foldable once the map is full — the bound is on cells, not
    // observations.
    agg.observe("a", at, increment);

    expect(agg.size).toBe(2);
    expect(agg.takeOverflow()).toBe(2);
    // Taking resets, so a periodic poll reports deltas rather than a running total.
    expect(agg.takeOverflow()).toBe(0);

    const buckets = agg.flush(at, true);
    expect(buckets.find((b) => b.key === "a")?.counts).toBe(2);
    expect(buckets.find((b) => b.key === "c")).toBeUndefined();
  });

  it("is unbounded when maxKeys is not set", () => {
    const agg = new Aggregator<number, number>({ bucketMs: MINUTE });
    const at = new Date("2026-07-30T12:00:00Z");
    for (let i = 0; i < 500; i++) {
      agg.observe(i, at, increment);
    }
    expect(agg.size).toBe(500);
    expect(agg.takeOverflow()).toBe(0);
  });

  it("orders flushed buckets by window, then by keyOrder when given", () => {
    const agg = new Aggregator<string, number>({
      bucketMs: MINUTE,
      keyOrder: (a, b) => a.localeCompare(b),
    });
    agg.observe("b", new Date("2026-07-30T12:01:00Z"), increment);
    agg.observe("c", new Date("2026-07-30T12:00:00Z"), increment);
    agg.observe("a", new Date("2026-07-30T12:00:00Z"), increment);

    expect(agg.flush(new Date("2026-07-30T12:05:00Z"), true).map((b) => b.key)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("folds arbitrary counter shapes, not just numbers", () => {
    interface Counts {
      hits: number;
      bytes: number;
    }
    const agg = new Aggregator<string, Counts>({ bucketMs: MINUTE });
    const at = new Date("2026-07-30T12:00:00Z");
    const fold = (bytes: number) => (current: Counts | undefined) => ({
      hits: (current?.hits ?? 0) + 1,
      bytes: (current?.bytes ?? 0) + bytes,
    });

    agg.observe("GET /x", at, fold(10));
    agg.observe("GET /x", at, fold(32));

    expect(agg.flush(at, true)[0]?.counts).toEqual({ hits: 2, bytes: 42 });
  });

  it("falls back to the default window for a non-positive bucket size", () => {
    const agg = new Aggregator<string, number>({ bucketMs: 0 });
    agg.observe("a", new Date("2026-07-30T12:00:30Z"), increment);
    expect(agg.flush(new Date("2026-07-30T12:05:00Z"), true)[0]?.sizeMs).toBe(MINUTE);
  });

  it("does not collide cells whose key and window stringify alike", () => {
    const agg = new Aggregator<string, number>({ bucketMs: 1000 });
    const at = new Date(1_000_000);
    agg.observe("1 a", at, increment);
    agg.observe("a", at, increment);
    expect(agg.size).toBe(2);
  });
});
