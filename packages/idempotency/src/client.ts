import {
  IDEMPOTENCY_KEY_HEADER,
  newIdempotencyKey,
  type IdempotencyKey,
  type KeyDeps,
} from "./key.js";

/**
 * The methods that participate by default. Safe methods are excluded even when a key is
 * present: they have no effect to deduplicate, and recording them would spend the store on
 * nothing.
 */
export const IDEMPOTENT_METHODS: readonly string[] = ["POST", "PUT", "PATCH", "DELETE"];

/** Options for {@link idempotentFetch}. */
export interface IdempotentFetchOptions extends KeyDeps {
  /** The `fetch` to delegate to. Defaults to the global. */
  fetch?: typeof fetch;
  /**
   * Reuse an existing key instead of minting one — for a caller that already has the key
   * (rehydrating a resumed operation, say, or one it logged before the first attempt).
   */
  key?: IdempotencyKey;
  /** Overrides the header the key is sent in. */
  headerName?: string;
  /** Overrides which methods carry the key. */
  methods?: readonly string[];
}

/** A `fetch` that stamps one operation's idempotency key on every request it sends. */
export interface IdempotentFetch {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** The key this wrapper stamps. Log it: it is what a support request is traced by. */
  readonly key: IdempotencyKey;
  /** The header the key is sent in. */
  readonly headerName: string;
}

/** Guards the `Request` global, which an exotic host may not define even where `fetch` exists. */
function isRequest(input: RequestInfo | URL): input is Request {
  return typeof Request !== "undefined" && input instanceof Request;
}

/** Reads the method an about-to-be-sent request will use, defaulting as `fetch` does. */
function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method !== undefined) {
    return init.method.toUpperCase();
  }
  return isRequest(input) ? input.method.toUpperCase() : "GET";
}

/**
 * The headers the request would be sent with, unchanged. `fetch(request, init)` takes headers
 * from `init` *instead of* the request's when `init.headers` is present rather than merging
 * them, so stamping onto a merge of the two would resurrect headers the caller meant to drop.
 */
function effectiveHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  if (init?.headers !== undefined) {
    return new Headers(init.headers);
  }
  return new Headers(isRequest(input) ? input.headers : undefined);
}

/**
 * Binds one freshly minted idempotency key to a `fetch` wrapper, so every request it sends
 * carries that same key.
 *
 * **The wrapper is the key**, and that is the whole point of this shape. Build it once per
 * logical operation, outside the retry loop:
 *
 * ```ts
 * const send = idempotentFetch();                // mints once, OUTSIDE the loop
 * await policy.run(() => send("/charges", { method: "POST", body }));
 * ```
 *
 * Building it *inside* the loop mints a key per attempt — which looks like protection and
 * provides none, since a retry and a deliberate duplicate are byte-identical to the server. The
 * mistake is at least visible here, because the construction is what moved.
 *
 * There is deliberately no "mint a key per call" mode. A wrapper cannot tell a retry from a
 * second, intentional request, so inventing a key per call would offer nothing, and deriving one
 * from the request's content would fail the other way — deciding two intentional identical
 * charges are the same one and silently dropping the second. Only the caller knows where a
 * logical operation begins.
 *
 * An already-set header always wins, and safe methods are left alone.
 */
export function idempotentFetch(options: IdempotentFetchOptions = {}): IdempotentFetch {
  const headerName = options.headerName ?? IDEMPOTENCY_KEY_HEADER;
  const methods = options.methods ?? IDEMPOTENT_METHODS;
  const key =
    options.key ??
    newIdempotencyKey(
      options.generate !== undefined ? { generate: options.generate } : {},
    );
  const delegate =
    options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  const send = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = effectiveHeaders(input, init);
    // An already-set key means the caller is managing keys itself; never override it.
    if (!methods.includes(methodOf(input, init)) || headers.has(headerName)) {
      return delegate(input, init);
    }

    // The header goes on a copy of `init` rather than being mutated in place: a caller that
    // builds one `init` outside its retry loop and passes it to every attempt must not have that
    // object rewritten underneath it.
    headers.set(headerName, key);
    return delegate(input, { ...init, headers });
  };

  return Object.assign(send, { key, headerName });
}
