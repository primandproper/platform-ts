import { PlatformError } from "@primandproper/errors";
import { provideIdentifierGenerator } from "@primandproper/identifiers";

/**
 * A client-minted identifier for a *logical operation*, so a retry of it can be recognised as
 * the same operation rather than as a new one.
 *
 * Branded rather than a bare `string` alias. {@link IdempotencyManager.run} takes a key and a
 * {@link Fingerprint} adjacently and both are strings underneath: as aliases a transposed pair
 * type-checks, runs, and silently disables mismatch detection — every request would
 * fingerprint-match itself, so one key reused for two different requests would replay the first
 * answer instead of being reported. A security control failing open with no signal is worth one
 * conversion at the wire boundary ({@link parseIdempotencyKey}).
 */
export type IdempotencyKey = string & { readonly __brand: "idempotency-key" };

/**
 * Identifies *what* the operation was, so a key reused for a different request can be detected.
 * Branded for the same reason as {@link IdempotencyKey}; build one with the helpers in
 * `fingerprint.ts` rather than casting.
 */
export type Fingerprint = string & { readonly __brand: "idempotency-fingerprint" };

/** The request header both halves of this package agree on, matching what Stripe publishes. */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

/** The longest key accepted by default, matching the limit Stripe publishes for the same header. */
export const DEFAULT_MAX_KEY_LENGTH = 255;

/** Error codes thrown by this package. Namespaced per the `errors` package's open-code stance. */
export const IdempotencyErrorCode = {
  /** An empty key was supplied. */
  keyRequired: "idempotency/key-required",
  /** The key is longer than the configured maximum. */
  keyTooLong: "idempotency/key-too-long",
  /** The key contains bytes outside printable, space-free ASCII. */
  keyInvalid: "idempotency/key-invalid",
  /** `run` was called without a fingerprint, which would disable mismatch detection entirely. */
  fingerprintRequired: "idempotency/fingerprint-required",
  /** The record store could not be reached and the manager is configured to fail closed. */
  storeUnavailable: "idempotency/store-unavailable",
} as const;

/** Injectable key generation, so a test can pin the minted value. */
export interface KeyDeps {
  /** Produces the raw string a fresh key is built from. Defaults to a nanoid. */
  generate?: () => string;
}

const defaultGenerator = provideIdentifierGenerator();

/**
 * Mints a fresh key.
 *
 * Call it **once per logical operation, outside any retry loop**. That placement is the whole
 * contract: every attempt must send the same key, which is what lets the server recognise a
 * retry. A key minted inside the loop is a new key per attempt — it looks like protection and
 * provides none, and nothing on the server can detect the mistake, because a retry and a
 * deliberate duplicate are byte-identical.
 *
 * There is deliberately no round trip to acquire a key: a request that times out never returns
 * anything, which is precisely the case this package exists for.
 */
export function newIdempotencyKey(deps: KeyDeps = {}): IdempotencyKey {
  const generate = deps.generate ?? (() => defaultGenerator.generate());
  return generate() as IdempotencyKey;
}

/**
 * Validates a client-supplied key, throwing a {@link PlatformError} when it is unusable.
 *
 * A key becomes both a store key and a lock key, so it is restricted rather than escaped:
 * printable ASCII with no spaces, which admits the UUIDs, nanoids, and base64url tokens clients
 * actually send while excluding control characters and anything that travels badly in a header.
 *
 * `identifiers`' own `isValid` is deliberately not used: it accepts only the scheme it generates,
 * and keys arriving here are minted by third-party clients — rejecting a well-formed UUID would
 * break every caller doing the ordinary thing. A non-positive `maxLength` disables the length
 * check.
 */
export function validateIdempotencyKey(
  key: string,
  maxLength: number = DEFAULT_MAX_KEY_LENGTH,
): void {
  if (key === "") {
    throw new PlatformError(IdempotencyErrorCode.keyRequired, "empty idempotency key");
  }
  if (maxLength > 0 && key.length > maxLength) {
    throw new PlatformError(
      IdempotencyErrorCode.keyTooLong,
      `idempotency key exceeds the maximum length of ${String(maxLength)}`,
    );
  }
  for (const char of key) {
    // Code units, not code points: the check is over the wire representation, and anything
    // outside printable ASCII is rejected whole rather than decoded.
    const code = char.charCodeAt(0);
    if (char.length > 1 || code <= 0x20 || code > 0x7e) {
      throw new PlatformError(
        IdempotencyErrorCode.keyInvalid,
        "idempotency key contains disallowed characters",
      );
    }
  }
}

/**
 * Validates a key arriving over the wire and brands it. The conversion point the branded types
 * exist for — a handler reads the header, parses it here, and passes a typed value onward.
 */
export function parseIdempotencyKey(
  key: string,
  maxLength: number = DEFAULT_MAX_KEY_LENGTH,
): IdempotencyKey {
  validateIdempotencyKey(key, maxLength);
  return key as IdempotencyKey;
}

/**
 * Brands an already-computed fingerprint. For callers that compute their own digest instead of
 * using this package's helpers; an empty fingerprint is rejected by `run` rather than here.
 */
export function asFingerprint(fingerprint: string): Fingerprint {
  return fingerprint as Fingerprint;
}
