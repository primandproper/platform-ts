import { promisify } from "node:util";
import {
  brotliCompress,
  brotliDecompress,
  deflate,
  gzip,
  inflate,
  unzip,
  type InputType,
} from "node:zlib";

import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type { Compressor } from "../compression.js";

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

interface Codec {
  compress: ZlibFn;
  decompress: ZlibFn;
}

const CODECS: Record<ZlibAlgorithm, Codec> = {
  gzip: { compress: gzipAsync, decompress: unzipAsync },
  deflate: { compress: deflateAsync, decompress: inflateAsync },
  brotli: { compress: brotliCompressAsync, decompress: brotliDecompressAsync },
};

/**
 * Node-only provider backed by `node:zlib`. Adds brotli on top of gzip/deflate, which the
 * web-standard `CompressionStream` does not offer.
 */
export class ZlibCompressor implements Compressor {
  readonly #codec: Codec;
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(options: ZlibCompressorOptions = {}, deps: ObservabilityDeps = {}) {
    this.#codec = CODECS[options.algorithm ?? "gzip"];
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  async compress(data: Uint8Array): Promise<Uint8Array> {
    this.#logger.debug("compressing");
    return new Uint8Array(await this.#codec.compress(data));
  }

  async decompress(data: Uint8Array): Promise<Uint8Array> {
    this.#logger.debug("decompressing");
    return new Uint8Array(await this.#codec.decompress(data));
  }
}
