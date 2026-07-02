import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import { pipeThrough, type Compressor } from "../compression.js";

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
  readonly #logger: Logger;

  constructor(options: WebStandardCompressorOptions = {}, deps: ObservabilityDeps = {}) {
    this.#format = options.format ?? "gzip";
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  compress(data: Uint8Array): Promise<Uint8Array> {
    this.#logger.debug("compressing");
    return pipeThrough(data, new CompressionStream(this.#format));
  }

  decompress(data: Uint8Array): Promise<Uint8Array> {
    this.#logger.debug("decompressing");
    return pipeThrough(data, new DecompressionStream(this.#format));
  }
}
