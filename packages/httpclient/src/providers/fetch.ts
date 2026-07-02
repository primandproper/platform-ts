import { SpanStatusCode } from "@opentelemetry/api";
import {
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
    this.#retry =
      options.retry === undefined
        ? undefined
        : exponentialBackoff(options.retry, { logger: this.#observer.logger() });
  }

  request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>> {
    return this.#observer.run(`HTTP ${req.method}`, async (op) => {
      const url = this.#resolveUrl(req.url, req.query);
      const init = this.#buildInit(req);

      // Fan-out: these land on the span and on the operation logger, so the warn/error below
      // carries the method, url, and status without restating them.
      op.set("http.request.method", req.method);
      op.set("url.full", url);

      // Resolve a fresh signal per attempt so a retried request gets its own timeout window
      // rather than inheriting an already-aborted signal from a prior attempt.
      const attempt = (): Promise<Response> => {
        const signal = this.#resolveSignal(req);
        return this.#fetch(url, signal === undefined ? init : { ...init, signal });
      };
      let raw: Response;
      try {
        raw =
          this.#retry === undefined ? await attempt() : await this.#retry.run(attempt);
      } catch (err) {
        // run() records the exception and sets the span status; log it here too.
        op.logger().error(`request to ${url} failed`, err);
        throw err;
      }

      op.set("http.response.status_code", raw.status);
      if (!raw.ok) {
        op.span().setStatus({ code: SpanStatusCode.ERROR });
        op.logger().warn(`request to ${url} failed with status ${String(raw.status)}`);
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

  #buildInit(req: HttpRequest): RequestInit {
    const headers = new Headers(this.#headers);
    if (req.headers !== undefined) {
      for (const [key, value] of Object.entries(req.headers)) {
        headers.set(key, value);
      }
    }

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
 * Materializes a `Response` into an {@link HttpResponse}. The body is read once, up front, so
 * `data` is the real parsed value (JSON by default, `undefined` for an empty body) rather than
 * a promise masquerading as `T`. `text()`/`json()` re-expose the same cached body, so callers
 * who want the raw form or a differently-typed parse never re-read the stream.
 */
async function wrapResponse<T>(raw: Response): Promise<HttpResponse<T>> {
  const bodyText = await raw.text();
  const parse = (): unknown => {
    if (bodyText === "") {
      return undefined;
    }
    return JSON.parse(bodyText) as unknown;
  };

  return {
    ok: raw.ok,
    status: raw.status,
    statusText: raw.statusText,
    headers: raw.headers,
    data: parse() as T,
    text: () => Promise.resolve(bodyText),
    json: <U = T>() => Promise.resolve(parse() as U),
  };
}
