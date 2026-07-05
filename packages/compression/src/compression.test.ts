import { makeRecordingObserver } from "@primandproper/observability";
import { describe, expect, it } from "vitest";

import { CompressionError, type Compressor } from "./compression.js";
import { NoopCompressor } from "./providers/noop.js";
import { WebStandardCompressor } from "./providers/web-standard.js";
import { ZlibCompressor } from "./providers/zlib.node.js";

/** Highly compressible payload: the same byte repeated, so output should shrink. */
const compressible = new Uint8Array(1024).fill(65);
const encoder = new TextEncoder();

/** A single-chunk `ReadableStream` over the given bytes. */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Collects a `ReadableStream` into a single `Uint8Array`. */
async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

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

    it("round-trips through the streaming surface", async () => {
      const compressor = make();
      const original = encoder.encode("the quick brown fox jumps over the lazy dog");
      const compressed = compressor.compressStream(streamOf(original));
      const restored = await collect(compressor.decompressStream(compressed));
      expect(restored).toStrictEqual(original);
    });

    it("streaming compress agrees with one-shot compress on the wire", async () => {
      const compressor = make();
      const original = encoder.encode("streaming and buffered outputs must interop");
      // The streamed output must decode via the buffered path (proves same wire format).
      const streamed = await collect(compressor.compressStream(streamOf(original)));
      expect(await compressor.decompress(streamed)).toStrictEqual(original);
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

/** Bytes that are not valid compressed input for any codec, so decompression must fail. */
const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

describe("corrupt input surfaces a typed CompressionError", () => {
  it("wraps a web-standard decompress failure", async () => {
    await expect(new WebStandardCompressor().decompress(garbage)).rejects.toBeInstanceOf(
      CompressionError,
    );
  });

  it("wraps a zlib decompress failure", async () => {
    await expect(
      new ZlibCompressor({ algorithm: "brotli" }).decompress(garbage),
    ).rejects.toBeInstanceOf(CompressionError);
  });
});

describe("spans carry input and output byte sizes", () => {
  it("records them for the web-standard provider", async () => {
    const observer = makeRecordingObserver();
    const input = encoder.encode("measure the bytes in and the bytes out");
    const output = await new WebStandardCompressor({}, { observer }).compress(input);
    const data = observer.data();
    expect(data["input.bytes"]).toBe(input.length);
    expect(data["output.bytes"]).toBe(output.length);
  });

  it("records them for the zlib provider", async () => {
    const observer = makeRecordingObserver();
    const input = encoder.encode("measure the bytes in and the bytes out");
    const output = await new ZlibCompressor(
      { algorithm: "brotli" },
      { observer },
    ).compress(input);
    const data = observer.data();
    expect(data["input.bytes"]).toBe(input.length);
    expect(data["output.bytes"]).toBe(output.length);
  });
});
