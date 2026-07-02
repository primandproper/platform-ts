/**
 * Narrows a `Uint8Array` to a guaranteed `ArrayBuffer`-backed view so it satisfies WebCrypto's
 * `BufferSource` parameter type, which rejects the `SharedArrayBuffer`-possible
 * `Uint8Array<ArrayBufferLike>` that `subarray` and typed params now produce under modern TS
 * libs. Zero-copy in the common case; copies only when the source is `SharedArrayBuffer`-backed.
 */
export function bufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
