/**
 * Browser entry: the client half only — minting a key, fingerprinting a request, and the `fetch`
 * wrapper that keeps one key stable across retries.
 *
 * The server-side manager is absent rather than stubbed. It needs a record store and a
 * distributed lock, neither of which exists in a browser, and a noop stand-in would be the worst
 * possible shape: idempotency that looks wired up and guarantees nothing. Importing
 * `provideIdempotencyManager` in browser-resolved code is therefore a type error, which is the
 * intended feedback.
 *
 * Splitting the package this way is what makes the "mint outside the retry loop" rule
 * enforceable in the place it actually gets broken — the retrying client.
 */
export * from "./client.js";
export * from "./fingerprint.js";
export * from "./key.js";
