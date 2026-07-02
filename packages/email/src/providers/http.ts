import type { Recipients } from "../email.js";

/** The slice of `fetch` the REST providers rely on. Injectable so tests need no network. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Resolves the `fetch` to use: an injected one, else the global, else an explanatory throw. */
export function resolveFetch(fetchImpl?: FetchLike): FetchLike {
  if (fetchImpl !== undefined) return fetchImpl;
  if (typeof globalThis.fetch === "function") {
    // Bind so the global fetch keeps its `this` when called as a bare reference.
    return globalThis.fetch.bind(globalThis);
  }
  throw new Error("no fetch implementation available; pass one via options.fetch");
}

/** Normalizes recipients to an array. */
export function recipientList(recipients: Recipients): string[] {
  return Array.isArray(recipients) ? recipients : [recipients];
}
