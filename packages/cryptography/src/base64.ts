/**
 * Isomorphic base64 <-> `Uint8Array` helpers. Built on the `atob`/`btoa` globals, which
 * exist in both Node 20+ and browsers, so this module stays Node-free (no `Buffer`) and
 * usable from universal code on either side of the wire.
 */

/** Encodes raw bytes as a standard (non-URL-safe) base64 string. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
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
