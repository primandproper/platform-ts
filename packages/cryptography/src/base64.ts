/**
 * Isomorphic base64 <-> `Uint8Array` helpers. Built on the `atob`/`btoa` globals, which
 * exist in both Node 20+ and browsers, so this module stays Node-free (no `Buffer`) and
 * usable from universal code on either side of the wire.
 */

/**
 * Bytes fed to `String.fromCharCode` per call. Chunking keeps the binary string built in O(n/CHUNK)
 * concatenations instead of one `+=` per byte, while staying under the engine's argument-count
 * ceiling for a spread call.
 */
const BINARY_CHUNK = 0x8000;

/** Builds the latin1 "binary string" `btoa` expects, chunked to avoid per-byte concatenation. */
function bytesToBinaryString(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += BINARY_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BINARY_CHUNK));
  }
  return binary;
}

/** Encodes raw bytes as a standard (non-URL-safe) base64 string. */
export function bytesToBase64(bytes: Uint8Array): string {
  return btoa(bytesToBinaryString(bytes));
}

/** Decodes a standard (non-URL-safe) base64 string into raw bytes. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Decodes a base64-encoded key, turning `atob`'s bare `InvalidCharacterError` into a clear,
 * actionable message. Use this for key material so a misconfigured key fails at construction
 * with a message that names the problem rather than an opaque DOM exception.
 */
export function decodeBase64Key(base64: string): Uint8Array {
  try {
    return base64ToBytes(base64);
  } catch {
    throw new Error("invalid encryption key: value is not valid base64");
  }
}
