/**
 * Text<->bytes helpers shared by the codecs. `TextEncoder`/`TextDecoder` are web standards
 * available on both Node 20+ and browsers, so this module stays Node-free. A single shared
 * encoder/decoder pair is safe — both are stateless across `encode`/`decode` calls.
 */
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** Encodes a string to UTF-8 bytes. */
export function textToBytes(text: string): Uint8Array {
  return utf8Encoder.encode(text);
}

/** Decodes UTF-8 bytes back to a string. */
export function bytesToText(data: Uint8Array): string {
  return utf8Decoder.decode(data);
}

/**
 * Returns an `ArrayBuffer`-backed view of `bytes`, satisfying web APIs (e.g. `Response`'s
 * `BodyInit`) that reject the `SharedArrayBuffer`-possible `Uint8Array<ArrayBufferLike>`.
 * Zero-copy unless the source is `SharedArrayBuffer`-backed.
 */
export function arrayBufferBacked(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
