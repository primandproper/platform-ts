/**
 * The universal compression contract: bytes in, bytes out. A thin wrapper over the runtime's
 * native compression — `CompressionStream` on both Node 20+ and browsers, `node:zlib` for the
 * algorithms (e.g. brotli) the web standard doesn't cover.
 */
export interface Compressor {
  /** Compresses the given bytes, returning the compressed bytes. */
  compress(data: Uint8Array): Promise<Uint8Array>;
  /** Reverses {@link compress}, returning the original bytes. */
  decompress(data: Uint8Array): Promise<Uint8Array>;
}

/**
 * Runs `data` through a transform stream (a `CompressionStream` or `DecompressionStream`) and
 * collects the result as a single `Uint8Array`. Node-free: `Response` is a web standard
 * available on both Node 20+ and browsers.
 */
export async function pipeThrough(
  data: Uint8Array,
  transform: ReadableWritablePair<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>,
): Promise<Uint8Array> {
  const bytes = arrayBufferBacked(data);
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const stream = source.pipeThrough(transform);
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Returns an `ArrayBuffer`-backed view of `bytes`, satisfying the web stream APIs' element type
 * (which rejects the `SharedArrayBuffer`-possible `Uint8Array<ArrayBufferLike>`). Zero-copy
 * unless the source is `SharedArrayBuffer`-backed.
 */
function arrayBufferBacked(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
