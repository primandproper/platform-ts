import {
  context,
  type Counter,
  type Histogram,
  propagation,
  SpanStatusCode,
} from "@opentelemetry/api";
import {
  makeMetrics,
  makeObserver,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";
import { exponentialBackoff, type Policy } from "@primandproper/retry";

import type { HttpClientConfig } from "../config.js";
import {
  assertOk,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  type RequestOptions,
} from "../httpclient.js";

const o11yName = "httpclient";

/** The slice of `fetch` the client relies on. Injectable so tests need no network. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Provider construction options: validated config plus an injectable `fetch`. */
export interface FetchHttpClientOptions extends HttpClientConfig {
  /** The `fetch` implementation. Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
}

function isBodyInit(value: unknown): value is BodyInit {
  return (
    typeof value === "string" ||
    value instanceof Blob ||
    value instanceof ArrayBuffer ||
    value instanceof FormData ||
    value instanceof URLSearchParams ||
    value instanceof ReadableStream ||
    ArrayBuffer.isView(value)
  );
}

/**
 * Universal {@link HttpClient} backed by the global `fetch`. Shared by both the Node and
 * browser builds — `fetch`, `Request`, `Response`, and `AbortSignal` all exist in Node 20+
 * and the browser, so there is nothing environment-specific here.
 */
export class FetchHttpClient implements HttpClient {
  readonly #fetch: FetchLike;
  readonly #baseUrl: string | undefined;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #retry: Policy | undefined;
  readonly #observer: Observer;
  readonly #requests: Counter;
  readonly #duration: Histogram;

  constructor(options: FetchHttpClientOptions, deps: ObservabilityDeps = {}) {
    if (options.fetch !== undefined) {
      this.#fetch = options.fetch;
    } else if (typeof globalThis.fetch === "function") {
      // Bind so the global fetch keeps its `this` when called as a bare reference.
      this.#fetch = globalThis.fetch.bind(globalThis);
    } else {
      throw new Error("no fetch implementation available; pass one via options.fetch");
    }
    this.#baseUrl = options.baseUrl;
    this.#headers = options.headers;
    this.#timeoutMs = options.timeoutMs;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    const metrics = makeMetrics(o11yName, deps.metrics);
    this.#requests = metrics.counter("httpclient.requests", {
      description: "Count of HTTP requests, by method and response status.",
    });
    this.#duration = metrics.histogram("httpclient.request.duration", {
      unit: "ms",
      description: "Duration of HTTP requests, by method and response status.",
    });
    this.#retry =
      options.retry === undefined
        ? undefined
        : exponentialBackoff(options.retry, { logger: this.#observer.logger() });
  }

  request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>> {
    return this.#observer.run(`HTTP ${req.method}`, async (op) => {
      const url = this.#resolveUrl(req.url, req.query);
      // Telemetry never carries query-string values: they routinely hold tokens/secrets (INST-7).
      // The real fetch below still uses the full `url`; only what lands on spans/logs is stripped.
      const safeUrl = redactQuery(url);
      const init = this.#buildInit(req);

      // Fan-out: these land on the span and on the operation logger, so the warn/error below
      // carries the method, url, and status without restating them.
      op.set("http.request.method", req.method);
      op.set("url.full", safeUrl);

      // Resolve a fresh signal per attempt so a retried request gets its own timeout window
      // rather than inheriting an already-aborted signal from a prior attempt.
      const attempt = (): Promise<Response> => {
        const signal = this.#resolveSignal(req);
        return this.#fetch(url, signal === undefined ? init : { ...init, signal });
      };
      // Only retry when the method (or an explicit override) is safe to replay — a POST/PATCH
      // that failed after the server received it must not be re-sent blindly. The caller's
      // signal drives the retry loop so a caller abort cancels the backoff sleep immediately
      // instead of sleeping out the full delay; each attempt still mints its own timeout signal.
      const retryable =
        this.#retry !== undefined && (req.idempotent ?? isIdempotentMethod(req.method));
      const start = performance.now();
      let raw: Response;
      try {
        raw =
          this.#retry !== undefined && retryable
            ? await this.#retry.run(attempt, { signal: req.signal })
            : await attempt();
      } catch (err) {
        // A transport failure has no HTTP status; record the attempt tagged "error" so the
        // request counter/histogram still see it, then let op.error log+record once.
        this.#record(req.method, "error", start);
        // op.error records the exception, sets the span status, and logs once; run() sees the
        // recorded flag and won't double up.
        throw op.error(err, `request to ${safeUrl} failed`);
      }

      this.#record(req.method, raw.status, start);
      op.set("http.response.status_code", raw.status);
      if (!raw.ok) {
        op.span().setStatus({ code: SpanStatusCode.ERROR });
        op.logger().warn(
          `request to ${safeUrl} failed with status ${String(raw.status)}`,
        );
      }

      const response = await wrapResponse<T>(raw);
      if (req.throwOnError === true) {
        return assertOk(response);
      }
      return response;
    });
  }

  get<T = unknown>(url: string, opts?: RequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>({ method: "GET", url, ...opts });
  }

  post<T = unknown>(
    url: string,
    body?: unknown,
    opts?: RequestOptions,
  ): Promise<HttpResponse<T>> {
    return this.request<T>({ method: "POST", url, body, ...opts });
  }

  put<T = unknown>(
    url: string,
    body?: unknown,
    opts?: RequestOptions,
  ): Promise<HttpResponse<T>> {
    return this.request<T>({ method: "PUT", url, body, ...opts });
  }

  patch<T = unknown>(
    url: string,
    body?: unknown,
    opts?: RequestOptions,
  ): Promise<HttpResponse<T>> {
    return this.request<T>({ method: "PATCH", url, body, ...opts });
  }

  delete<T = unknown>(url: string, opts?: RequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>({ method: "DELETE", url, ...opts });
  }

  #resolveUrl(url: string, query?: Record<string, string | number | boolean>): string {
    const resolved =
      this.#baseUrl === undefined ? new URL(url) : new URL(url, withSlash(this.#baseUrl));
    if (query !== undefined) {
      for (const [key, value] of Object.entries(query)) {
        resolved.searchParams.set(key, String(value));
      }
    }
    return resolved.toString();
  }

  /** Records the request counter and duration histogram tagged by method and outcome. */
  #record(method: string, status: number | "error", start: number): void {
    const attributes = {
      "http.request.method": method,
      "http.response.status_code": status,
    };
    this.#requests.add(1, attributes);
    this.#duration.record(performance.now() - start, attributes);
  }

  #buildInit(req: HttpRequest): RequestInit {
    const headers = new Headers(this.#headers);
    if (req.headers !== undefined) {
      for (const [key, value] of Object.entries(req.headers)) {
        headers.set(key, value);
      }
    }

    // Inject W3C trace context (traceparent/tracestate) so the span continues across the
    // service boundary. #buildInit runs inside observer.run's active span, so context.active()
    // carries it; a caller-supplied header of the same name is overwritten deliberately.
    propagation.inject(context.active(), headers, {
      set: (carrier, key, value) => {
        carrier.set(key, value);
      },
    });

    let body: BodyInit | undefined;
    if (req.body !== undefined) {
      if (isBodyInit(req.body)) {
        body = req.body;
      } else {
        body = JSON.stringify(req.body);
        if (!headers.has("content-type")) {
          headers.set("content-type", "application/json");
        }
      }
    }

    const init: RequestInit = { method: req.method, headers };
    if (body !== undefined) {
      init.body = body;
    }
    return init;
  }

  #resolveSignal(req: HttpRequest): AbortSignal | undefined {
    const timeoutMs = req.timeoutMs ?? this.#timeoutMs;
    const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;

    if (timeoutSignal === undefined) {
      return req.signal;
    }
    if (req.signal === undefined) {
      return timeoutSignal;
    }
    return AbortSignal.any([req.signal, timeoutSignal]);
  }
}

function withSlash(base: string): string {
  return base.endsWith("/") ? base : `${base}/`;
}

/**
 * Whether a method is safe to retry after a transport failure. GET/PUT/DELETE are idempotent
 * (a replay lands the same state); POST/PATCH are not, so retrying them risks a duplicate.
 */
function isIdempotentMethod(method: string): boolean {
  return method === "GET" || method === "PUT" || method === "DELETE";
}

/**
 * Strips the query string from a URL for telemetry. Query params routinely carry access tokens,
 * signatures, and other secrets that must not leak into spans or logs. A URL that fails to parse
 * is returned unchanged rather than dropped.
 */
function redactQuery(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Materializes a `Response` into an {@link HttpResponse}. The body is read once, up front. Eager
 * decoding of `data` is gated on the response's content-type: a JSON body is parsed, but a
 * `text/plain`/HTML body keeps its raw text as `data` rather than throwing a `SyntaxError` that
 * would sink the whole request. `json()` parses on demand and memoizes, so repeated calls never
 * re-parse; `text()` re-exposes the cached raw body.
 */
async function wrapResponse<T>(raw: Response): Promise<HttpResponse<T>> {
  const bodyText = await raw.text();

  // Parse lazily and memoize the successful result so repeated json() calls don't re-parse.
  let parsed: unknown;
  let didParse = false;
  const parseJson = (): unknown => {
    if (!didParse) {
      parsed = bodyText === "" ? undefined : (JSON.parse(bodyText) as unknown);
      didParse = true;
    }
    return parsed;
  };

  // `data` decodes JSON eagerly (the common case); anything else stays raw text so a non-JSON 2xx
  // still resolves. An empty body is `undefined` regardless of content-type.
  const decodeData = (): unknown => {
    if (bodyText === "") {
      return undefined;
    }
    return isJsonContentType(raw.headers.get("content-type")) ? parseJson() : bodyText;
  };
  const data = decodeData() as T;

  return {
    ok: raw.ok,
    status: raw.status,
    statusText: raw.statusText,
    headers: raw.headers,
    data,
    text: () => Promise.resolve(bodyText),
    json: <U = T>() => Promise.resolve(parseJson() as U),
  };
}

/** Whether a Content-Type header names JSON (`application/json` or a `+json` structured suffix). */
function isJsonContentType(contentType: string | null): boolean {
  if (contentType === null) {
    return false;
  }
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}
