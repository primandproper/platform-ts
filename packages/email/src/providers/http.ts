import type { Logger } from "@primandproper/observability";
import { exponentialBackoff, type Policy, type RetryConfig } from "@primandproper/retry";

import type { Recipients } from "../email.js";

/** The slice of `fetch` the REST providers rely on. Injectable so tests need no network. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Thirty seconds, in milliseconds — the default per-request deadline for a vendor call. */
export const DEFAULT_EMAIL_TIMEOUT_MS = 30_000;

/**
 * Whether a vendor response status is worth retrying. Vendors document request-timeout (408),
 * rate-limit (429), and 5xx as transient; a 4xx is a client error that a replay won't fix.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Internal marker thrown so the retry policy re-attempts a retryable-status response. It carries
 * the offending {@link Response} so that once retries are exhausted the provider still reads its
 * body/headers for the error log instead of losing them.
 */
class RetryableResponseError extends Error {
  readonly response: Response;
  constructor(response: Response) {
    super(`retryable HTTP status ${String(response.status)}`);
    this.name = "RetryableResponseError";
    this.response = response;
  }
}

/** Builds a per-request timeout signal combined with the caller's signal, if any. */
function requestSignal(timeoutMs: number, caller?: AbortSignal): AbortSignal | undefined {
  const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  if (timeout === undefined) return caller;
  if (caller === undefined) return timeout;
  return AbortSignal.any([caller, timeout]);
}

/** Per-call resilience: a timeout deadline and an optional retry policy. */
export interface ResilienceOptions {
  /** Per-attempt deadline in milliseconds; `0` disables it. */
  timeoutMs: number;
  /** Retry policy for transient failures. Omitted means a single attempt. */
  retry?: Policy | undefined;
  /** A caller abort signal, honored across attempts (including the backoff sleep). */
  signal?: AbortSignal | undefined;
}

/**
 * Runs a vendor `fetch` with a per-attempt timeout and, when a policy is supplied, retries on
 * transient failures (network/timeout errors and 429/5xx responses). A non-retryable response
 * (a 4xx, or any 2xx) is returned unchanged for the provider's normal handling. Each attempt gets
 * a fresh timeout window; the caller's `signal` cancels the whole loop, backoff included.
 *
 * Note: an email send is not idempotent, so retry is opt-in (off unless configured) — enabling it
 * accepts that an ambiguous failure (timeout/5xx after the vendor accepted the message) may
 * double-deliver.
 */
export async function resilientFetch(
  doFetch: (signal: AbortSignal | undefined) => Promise<Response>,
  opts: ResilienceOptions,
): Promise<Response> {
  const attempt = async (): Promise<Response> => {
    const response = await doFetch(requestSignal(opts.timeoutMs, opts.signal));
    if (opts.retry !== undefined && !response.ok && isRetryableStatus(response.status)) {
      throw new RetryableResponseError(response);
    }
    return response;
  };

  if (opts.retry === undefined) {
    return attempt();
  }
  try {
    return await opts.retry.run(attempt, { signal: opts.signal });
  } catch (err) {
    if (err instanceof RetryableResponseError) {
      // Retries exhausted on a retryable status: hand the final response back so the provider
      // logs the vendor's status/body rather than an opaque marker error.
      return err.response;
    }
    throw err;
  }
}

/** Builds a retry {@link Policy} from config, wiring the provider's logger for retry log lines. */
export function retryPolicy(
  config: RetryConfig | undefined,
  logger: Logger,
): Policy | undefined {
  return config === undefined ? undefined : exponentialBackoff(config, { logger });
}

/** Resolves the `fetch` to use: an injected one, else the global, else an explanatory throw. */
export function resolveFetch(fetchImpl?: FetchLike): FetchLike {
  if (fetchImpl !== undefined) return fetchImpl;
  if (typeof globalThis.fetch === "function") {
    // Bind so the global fetch keeps its `this` when called as a bare reference.
    return globalThis.fetch.bind(globalThis);
  }
  throw new Error("no fetch implementation available; pass one via options.fetch");
}

/**
 * Parses a response body as JSON, returning `undefined` when the body is empty or not valid
 * JSON instead of throwing. A vendor can answer a successful send with an empty or non-JSON 2xx
 * body; a message the vendor accepted must not surface as a failure just because we couldn't
 * read an id out of the response.
 */
export async function parseJsonBody<T>(response: Response): Promise<T | undefined> {
  const text = await response.text();
  if (text.trim() === "") {
    return undefined;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Normalizes recipients to an array. */
export function recipientList(recipients: Recipients): string[] {
  return Array.isArray(recipients) ? recipients : [recipients];
}

/** The domain of the first recipient (the part after `@`), attached to error logs. */
export function recipientDomain(recipients: Recipients): string {
  const first = recipientList(recipients)[0] ?? "";
  const at = first.lastIndexOf("@");
  return at === -1 ? "" : first.slice(at + 1);
}

/** The header names vendors use to carry a per-request id, in the order we prefer them. */
const requestIdHeaderNames = ["x-message-id", "x-request-id"];

/** Reads the vendor's request/message id from a response, trying the common header names. */
export function requestIdFromHeaders(headers: Headers): string | undefined {
  for (const name of requestIdHeaderNames) {
    const value = headers.get(name);
    if (value !== null && value !== "") {
      return value;
    }
  }
  return undefined;
}
