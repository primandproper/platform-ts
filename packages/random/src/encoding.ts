/**
 * Universal byte-encoders matching the encodings platform-go's `random` package emits:
 * lowercase hex (`hex.EncodeToString`), RFC 4648 standard base32 with padding
 * (`base32.StdEncoding`), and raw URL-safe base64 without padding (`base64.RawURLEncoding`).
 * Built on the `btoa` global, present in Node 20+ and browsers, so this module stays Node-free
 * (no `Buffer`) and usable from universal code on either side of the wire.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Encodes bytes as a lowercase hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/** Encodes bytes as RFC 4648 standard base32, padded with `=` to an 8-character boundary. */
export function bytesToBase32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(buffer >>> bits) & 0x1f] ?? "";
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(buffer << (5 - bits)) & 0x1f] ?? "";
  }
  while (out.length % 8 !== 0) {
    out += "=";
  }
  return out;
}

/**
 * Bytes fed to `String.fromCharCode` per call. Chunking keeps the binary string built in
 * O(n/CHUNK) concatenations instead of one `+=` per byte, while staying under the engine's
 * argument-count ceiling for a spread call.
 */
const BINARY_CHUNK = 0x8000;

/** Encodes bytes as raw URL-safe base64: `+/` become `-_` and trailing `=` padding is stripped. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += BINARY_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BINARY_CHUNK));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
