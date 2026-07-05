import type { Compressor } from "../compression.js";

/** Universal identity provider: returns its input unchanged. */
export class NoopCompressor implements Compressor {
  compress(data: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(data);
  }

  decompress(data: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(data);
  }

  compressStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    return source;
  }

  decompressStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    return source;
  }
}
