import {
  type Logger,
  makeMetrics,
  type Metrics,
  type ObservabilityDeps,
} from "@primandproper/observability";
import { exponentialBackoff, type Policy, type RetryConfig } from "@primandproper/retry";

type Counter = ReturnType<Metrics["counter"]>;

/** Thirty seconds, in milliseconds — the default per-request deadline for a vendor call. */
export const DEFAULT_LLM_TIMEOUT_MS = 30_000;

/**
 * Whether a vendor response status is worth retrying. Anthropic/OpenAI document overload (429)
 * and 5xx as transient; a 4xx is a client error (bad key, malformed request) a replay won't fix.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Internal marker thrown so the retry policy re-attempts a retryable-status response; it carries
 * the {@link Response} so the provider still reads the vendor's status/body once retries run out.
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
 * (a 4xx, or any 2xx) is returned unchanged for the provider's normal handling; each attempt gets
 * a fresh timeout window and the caller's `signal` cancels the whole loop, backoff included.
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

/**
 * The `llm.tokens.input` / `llm.tokens.output` counter pair every REST LLM provider mints in its
 * constructor. Token usage is the single most valuable LLM signal — it drives cost — so parsed
 * usage is turned into metrics tagged by model. The meter is registered under the component's
 * o11y name so instruments group with its spans and logs.
 */
export interface TokenInstruments {
  inputTokens: Counter;
  outputTokens: Counter;
}

/** Builds the `llm.tokens.input` / `llm.tokens.output` counters, defaulting to the noop meter. */
export function tokenInstruments(
  o11yName: string,
  deps: ObservabilityDeps | undefined,
): TokenInstruments {
  const metrics = makeMetrics(o11yName, deps?.metrics);
  return {
    inputTokens: metrics.counter("llm.tokens.input", {
      description: "Input tokens consumed by LLM completions, tagged by model.",
    }),
    outputTokens: metrics.counter("llm.tokens.output", {
      description: "Output tokens produced by LLM completions, tagged by model.",
    }),
  };
}

/**
 * Yields each SSE `data:` payload from a streaming response body, in order. Both Anthropic and
 * OpenAI frame their streams as `data: <json>` lines (Anthropic adds an `event:` line the JSON's
 * own `type` field makes redundant, so it is ignored); a literal `[DONE]` sentinel ends the OpenAI
 * stream and is not yielded. Decodes incrementally and buffers partial lines across chunks, so no
 * whole-payload buffering occurs. Throws if the body is absent.
 */
export async function* sseDataLines(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<string> {
  if (body === null) {
    throw new Error("streaming response has no body");
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trimEnd();
        buffer = buffer.slice(newline + 1);
        const payload = sseData(line);
        if (payload !== undefined) {
          if (payload === "[DONE]") {
            return;
          }
          yield payload;
        }
        newline = buffer.indexOf("\n");
      }
    }
    // Flush a trailing line with no closing newline.
    const payload = sseData(buffer.trimEnd());
    if (payload !== undefined && payload !== "[DONE]") {
      yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Extracts the payload of an SSE `data:` line, or `undefined` for any other line. */
function sseData(line: string): string | undefined {
  if (!line.startsWith("data:")) {
    return undefined;
  }
  return line.slice("data:".length).trimStart();
}

/**
 * Pulls the vendor request id off a failed response's headers, trying each name in order.
 * Anthropic returns `request-id`; OpenAI returns `x-request-id`. Returns `undefined` when the
 * header is absent so the caller can decide what to record.
 */
export function requestIdFromResponse(
  response: Response,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = response.headers.get(name);
    if (value !== null && value !== "") {
      return value;
    }
  }
  return undefined;
}
