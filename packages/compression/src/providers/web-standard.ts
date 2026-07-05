import {
  makeObserver,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import { CompressionError, pipeThrough, type Compressor } from "../compression.js";

const o11yName = "compression";

/** Algorithms the web-standard `CompressionStream` supports on both Node 20+ and browsers. */
export type WebStandardFormat = "gzip" | "deflate" | "deflate-raw";

export interface WebStandardCompressorOptions {
  /** The compression format. Defaults to `gzip`. */
  format?: WebStandardFormat;
}

/**
 * Universal provider built on the web-standard `CompressionStream`/`DecompressionStream`.
 * Available on both Node 20+ and browsers, so it is the default on either side. Node-free.
 */
export class WebStandardCompressor implements Compressor {
  readonly #format: CompressionFormat;
  readonly #observer: Observer;

  constructor(options: WebStandardCompressorOptions = {}, deps: ObservabilityDeps = {}) {
    this.#format = options.format ?? "gzip";
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
  }

  compress(data: Uint8Array): Promise<Uint8Array> {
    return this.#observer.run("compress", async (op) => {
      op.set("input.bytes", data.length);
      let output: Uint8Array;
      try {
        output = await pipeThrough(data, new CompressionStream(this.#format));
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
        output = await pipeThrough(data, new DecompressionStream(this.#format));
      } catch (err) {
        throw op.error(new CompressionError("decompress", err), "decompressing data");
      }
      op.set("output.bytes", output.length).logger().debug("decompressed");
      return output;
    });
  }

  compressStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    this.#observer.logger().debug("compressing stream");
    return source.pipeThrough(
      new CompressionStream(this.#format) as ReadableWritablePair<Uint8Array, Uint8Array>,
    );
  }

  decompressStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    this.#observer.logger().debug("decompressing stream");
    return source.pipeThrough(
      new DecompressionStream(this.#format) as ReadableWritablePair<
        Uint8Array,
        Uint8Array
      >,
    );
  }
}
