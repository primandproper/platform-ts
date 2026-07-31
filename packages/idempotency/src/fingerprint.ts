import { provideHashing, type Hasher } from "@primandproper/cryptography";

import { asFingerprint, type Fingerprint } from "./key.js";

/** Injectable digest, so a caller can pin the algorithm or a test can pin the output. */
export interface FingerprintDeps {
  /** Defaults to SHA-256 over WebCrypto, identical on Node and in the browser. */
  hasher?: Hasher;
}

const encoder = new TextEncoder();

const defaultHasher = provideHashing({ algorithm: "SHA-256" });

/** Renders a digest as lowercase hex — the wire form a fingerprint travels and is stored in. */
function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Hashes an ordered list of parts into a fingerprint.
 *
 * Each part is **length-prefixed** so that parts cannot run together: without it a path of `/a`
 * with principal `bc` and a path of `/ab` with principal `c` would hash identically, and one
 * user's recorded response could be replayed to another.
 */
export async function fingerprintOf(
  parts: readonly (string | Uint8Array)[],
  deps: FingerprintDeps = {},
): Promise<Fingerprint> {
  const hasher = deps.hasher ?? defaultHasher;
  const framed: Uint8Array[] = [];
  let length = 0;
  for (const part of parts) {
    const bytes = typeof part === "string" ? encoder.encode(part) : part;
    const prefix = encoder.encode(`${String(bytes.byteLength)}:`);
    framed.push(prefix, bytes);
    length += prefix.byteLength + bytes.byteLength;
  }

  const buffer = new Uint8Array(length);
  let offset = 0;
  for (const chunk of framed) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return asFingerprint(toHex(await hasher.hash(buffer)));
}

/**
 * Serialises a value to JSON with object keys sorted, recursively — the canonicalisation a
 * fingerprint over structured data needs.
 *
 * Two things would otherwise produce false mismatches, and a false mismatch is a *rejected
 * legitimate retry*: property order (`{a,b}` and `{b,a}` are the same request), and a client
 * that re-serialises its payload between attempts. Sorting fixes the first. The second is why
 * fingerprinting structured data is preferred over hashing raw bytes wherever the caller has
 * the parsed value to hand.
 *
 * What it commits to: keys sort by UTF-16 code unit; arrays keep their order (order is meaning
 * in an array); `undefined`, functions, and symbols drop out of objects and become `null` in
 * arrays, exactly as `JSON.stringify` does; `toJSON` is honoured, so a `Date` canonicalises to
 * its ISO string; `NaN`/`Infinity` become `null`. Number formatting is deterministic — the
 * ECMAScript spec pins `Number`-to-`String` — so `1.0` and `1` canonicalise identically, which
 * is the answer that treats a re-serialised payload as the same request.
 */
export function canonicalJson(value: unknown): string {
  // Handled up front because `JSON.stringify` returns `undefined` (not a string) for these,
  // which its lib type does not admit — and a fingerprint must always be a string.
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return "null";
  }

  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return entry;
    }
    // The replacer runs after `toJSON`, so anything reaching here is a plain-ish object whose
    // own enumerable keys are what get serialised — reordering them here reorders the output.
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    );
  });
}

/** Fingerprints a structured value through {@link canonicalJson}. */
export function fingerprintJson(
  value: unknown,
  deps: FingerprintDeps = {},
): Promise<Fingerprint> {
  return fingerprintOf([canonicalJson(value)], deps);
}

/** The parts of an HTTP request a fingerprint commits to. */
export interface RequestFingerprintInput {
  method: string;
  /** Absolute or relative; only the path and query participate. */
  url: string | URL;
  /**
   * Who is making the request. Include it: a fingerprint over the request alone would let the
   * same payload sent by two different users share one record, handing the second caller the
   * first's response.
   */
  principal?: string;
  /** The raw body, or a structured value to canonicalise via {@link canonicalJson}. */
  body?: string | Uint8Array;
}

/**
 * Fingerprints an HTTP request over method, path, sorted query, principal, and body.
 *
 * It covers more than the body on purpose — a key committed only to a body would let the same
 * payload posted to two endpoints share one record. The query is sorted rather than taken
 * verbatim, because `?a=1&b=2` and `?b=2&a=1` are the same request and reporting an ordinary
 * retry as key reuse is the expensive direction to be wrong in.
 */
export function fingerprintRequest(
  input: RequestFingerprintInput,
  deps: FingerprintDeps = {},
): Promise<Fingerprint> {
  // A base is supplied so a relative URL parses; only path and query are read back out, so the
  // placeholder origin never reaches the digest.
  const url =
    typeof input.url === "string"
      ? new URL(input.url, "http://fingerprint.invalid")
      : input.url;
  const query = new URLSearchParams(url.search);
  query.sort();

  return fingerprintOf(
    [
      input.method.toUpperCase(),
      url.pathname,
      query.toString(),
      input.principal ?? "",
      input.body ?? "",
    ],
    deps,
  );
}
