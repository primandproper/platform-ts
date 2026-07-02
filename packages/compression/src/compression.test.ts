import { describe, expect, it } from "vitest";

import type { Compressor } from "./compression.js";
import { NoopCompressor } from "./providers/noop.js";
import { WebStandardCompressor } from "./providers/web-standard.js";
import { ZlibCompressor } from "./providers/zlib.node.js";

/** Highly compressible payload: the same byte repeated, so output should shrink. */
const compressible = new Uint8Array(1024).fill(65);
const encoder = new TextEncoder();

/**
 * Provider-agnostic conformance suite. Running the same assertions against multiple providers
 * proves the `Compressor` interface is implementation-independent.
 */
function conformance(
  name: string,
  make: () => Compressor,
  opts: { readonly shrinks: boolean },
): void {
  describe(name, () => {
    it("round-trips bytes back to the original", async () => {
      const compressor = make();
      const original = encoder.encode("the quick brown fox jumps over the lazy dog");
      const compressed = await compressor.compress(original);
      const restored = await compressor.decompress(compressed);
      expect(restored).toStrictEqual(original);
    });

    it("round-trips an empty payload", async () => {
      const compressor = make();
      const compressed = await compressor.compress(new Uint8Array(0));
      expect(await compressor.decompress(compressed)).toStrictEqual(new Uint8Array(0));
    });

    it(opts.shrinks ? "shrinks compressible data" : "leaves data unchanged", async () => {
      const compressed = await make().compress(compressible);
      if (opts.shrinks) {
        expect(compressed.byteLength).toBeLessThan(compressible.byteLength);
      } else {
        expect(compressed).toStrictEqual(compressible);
      }
    });
  });
}

conformance("WebStandardCompressor (gzip)", () => new WebStandardCompressor(), {
  shrinks: true,
});
conformance(
  "WebStandardCompressor (deflate)",
  () => new WebStandardCompressor({ format: "deflate" }),
  { shrinks: true },
);
conformance("NoopCompressor", () => new NoopCompressor(), { shrinks: false });
conformance(
  "ZlibCompressor (brotli)",
  () => new ZlibCompressor({ algorithm: "brotli" }),
  { shrinks: true },
);

describe("WebStandardCompressor and ZlibCompressor interop", () => {
  it("decodes Node gzip output with the web-standard provider", async () => {
    const original = encoder.encode("interop across providers");
    const compressed = await new ZlibCompressor({ algorithm: "gzip" }).compress(original);
    const restored = await new WebStandardCompressor().decompress(compressed);
    expect(restored).toStrictEqual(original);
  });
});
