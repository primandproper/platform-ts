import { describe, expect, it } from "vitest";

import type { Cache } from "./cache.js";
import { InMemoryCache } from "./providers/memory.js";
import { NoopCache } from "./providers/noop.js";

/**
 * Provider-agnostic conformance suite. Running the same assertions against multiple
 * providers proves the `Cache<T>` interface is implementation-independent.
 */
function conformance(
  name: string,
  make: () => Cache<number>,
  opts: { readonly persists: boolean },
): void {
  describe(name, () => {
    it("returns undefined for a missing key", async () => {
      expect(await make().get("missing")).toBeUndefined();
    });

    it("round-trips a value", async () => {
      const cache = make();
      await cache.set("answer", 42);
      expect(await cache.get("answer")).toBe(opts.persists ? 42 : undefined);
    });

    it("deletes a stored value", async () => {
      const cache = make();
      await cache.set("k", 1);
      await cache.delete("k");
      expect(await cache.get("k")).toBeUndefined();
    });

    it("pings without throwing", async () => {
      await expect(make().ping()).resolves.toBeUndefined();
    });
  });
}

conformance("InMemoryCache", () => new InMemoryCache<number>(), { persists: true });
conformance("NoopCache", () => new NoopCache<number>(), { persists: false });

describe("InMemoryCache batching", () => {
  it("omits missing keys from getMany", async () => {
    const cache = new InMemoryCache<number>();
    await cache.setMany(
      new Map([
        ["a", 1],
        ["b", 2],
      ]),
    );
    const found = await cache.getMany(["a", "b", "c"]);
    expect([...found.entries()]).toStrictEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });
});
