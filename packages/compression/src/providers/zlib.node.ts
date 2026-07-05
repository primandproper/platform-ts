import { Duplex } from "node:stream";
import { promisify } from "node:util";
import {
  brotliCompress,
  brotliDecompress,
  createBrotliCompress,
  createBrotliDecompress,
  createDeflate,
  createGunzip,
  createGzip,
  createInflate,
  deflate,
  gzip,
  inflate,
  unzip,
  type InputType,
} from "node:zlib";

import {
  makeObserver,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import { CompressionError, type Compressor } from "../compression.js";

const o11yName = "compression";

/** Algorithms `node:zlib` provides — including brotli, which the web standard cannot. */
export type ZlibAlgorithm = "gzip" | "deflate" | "brotli";

export interface ZlibCompressorOptions {
  /** The compression algorithm. Defaults to `gzip`. */
  algorithm?: ZlibAlgorithm;
}

const gzipAsync = promisify(gzip);
const unzipAsync = promisify(unzip);
const deflateAsync = promisify(deflate);
const inflateAsync = promisify(inflate);
const brotliCompressAsync = promisify(brotliCompress);
const brotliDecompressAsync = promisify(brotliDecompress);

type ZlibFn = (buf: InputType) => Promise<Buffer>;

/** Factories for the streaming `Transform` counterparts, mirroring the one-shot codec above. */
interface StreamCodec {
  compress: () => Duplex;
  decompress: () => Duplex;
}

interface Codec {
  compress: ZlibFn;
  decompress: ZlibFn;
  stream: StreamCodec;
}

const CODECS: Record<ZlibAlgorithm, Codec> = {
  gzip: {
    compress: gzipAsync,
    decompress: unzipAsync,
    stream: { compress: createGzip, decompress: createGunzip },
  },
  deflate: {
    compress: deflateAsync,
    decompress: inflateAsync,
    stream: { compress: createDeflate, decompress: createInflate },
  },
  brotli: {
    compress: brotliCompressAsync,
    decompress: brotliDecompressAsync,
    stream: { compress: createBrotliCompress, decompress: createBrotliDecompress },
  },
};

/**
 * Node-only provider backed by `node:zlib`. Adds brotli on top of gzip/deflate, which the
 * web-standard `CompressionStream` does not offer.
 */
export class ZlibCompressor implements Compressor {
  readonly #codec: Codec;
  readonly #observer: Observer;

  constructor(options: ZlibCompressorOptions = {}, deps: ObservabilityDeps = {}) {
    this.#codec = CODECS[options.algorithm ?? "gzip"];
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
  }

  compress(data: Uint8Array): Promise<Uint8Array> {
    return this.#observer.run("compress", async (op) => {
      op.set("input.bytes", data.length);
      let output: Uint8Array;
      try {
        output = new Uint8Array(await this.#codec.compress(data));
      } catch (err) {
        throw op.error(new CompressionError("compress", err), "compressing data");
      }
      op.set("output.bytes", output.length).logger().debug("compressed");
      return output;
    });
  }

  decompress(data: Uint8Array): Promise<Uint8Array> {
    return this.#observer.run("decompress", async (op) => {
      op.set("input.bytes", data.length);
      let output: Uint8Array;
      try {
        output = new Uint8Array(await this.#codec.decompress(data));
      } catch (err) {
        throw op.error(new CompressionError("decompress", err), "decompressing data");
      }
      op.set("output.bytes", output.length).logger().debug("decompressed");
      return output;
    });
  }

  compressStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    this.#observer.logger().debug("compressing stream");
    return pipeThroughDuplex(source, this.#codec.stream.compress());
  }

  decompressStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    this.#observer.logger().debug("decompressing stream");
    return pipeThroughDuplex(source, this.#codec.stream.decompress());
  }
}

/**
 * Bridges a web `ReadableStream` through a Node `zlib` transform and back to a web stream via
 * `Duplex.toWeb`, so the streaming surface stays web-standard on the outside while reusing
 * `node:zlib`'s incremental transforms (no whole-payload buffering). A transform error propagates
 * onto the returned stream, matching the {@link Compressor} streaming contract.
 */
function pipeThroughDuplex(
  source: ReadableStream<Uint8Array>,
  transform: Duplex,
): ReadableStream<Uint8Array> {
  const web = Duplex.toWeb(transform) as ReadableWritablePair<Uint8Array, Uint8Array>;
  return source.pipeThrough(web);
}
