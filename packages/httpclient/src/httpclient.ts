import { PlatformError } from "@primandproper/errors";

/** A header bag accepted on requests. Values are stringified by the client. */
export type HeaderInit = Record<string, string>;

/** The HTTP methods the convenience helpers cover. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Per-request options shared by {@link HttpClient.request} and the convenience helpers.
 * Everything is optional; sensible defaults come from the client's config.
 */
export interface RequestOptions {
  /** Headers merged over (and overriding) the client's default headers. */
  headers?: HeaderInit;
  /** Query parameters appended to the URL. Existing query string is preserved. */
  query?: Record<string, string | number | boolean>;
  /**
   * Overrides the client's `timeoutMs` for this request. `0` disables the timeout. When a
   * `signal` is also supplied, whichever aborts first wins.
   */
  timeoutMs?: number;
  /** A caller-supplied abort signal, combined with the timeout signal. */
  signal?: AbortSignal;
  /**
   * When `true`, a non-2xx response rejects with an {@link HttpError} instead of resolving.
   * Defaults to `false` — the response is returned with `ok === false`.
   */
  throwOnError?: boolean;
  /**
   * Whether this request may be retried by the client's retry policy. Defaults to `true` for
   * idempotent methods (GET/PUT/DELETE) and `false` for POST/PATCH, since retrying a
   * non-idempotent request after a transport error risks a duplicate side effect (the server
   * may have processed the first attempt before the response was lost). Set explicitly to
   * override — e.g. `idempotent: true` on a POST that is safe to replay.
   */
  idempotent?: boolean;
}

/** A fully-specified request passed to {@link HttpClient.request}. */
export interface HttpRequest extends RequestOptions {
  method: HttpMethod;
  /** Absolute URL, or a path resolved against the client's `baseUrl`. */
  url: string;
  /**
   * The request body. A non-`BodyInit` value (plain object, array, etc.) is JSON-encoded and
   * sent with a `content-type: application/json` header unless one is already set.
   */
  body?: unknown;
}

/**
 * The result of a request. `data` is the parsed body (JSON by default); `text()` and `json()`
 * expose the raw body for callers that need it. A non-2xx response still resolves — inspect
 * `ok`/`status` — unless `throwOnError` was set.
 */
export interface HttpResponse<T> {
  /** `true` when `status` is in the 200–299 range. */
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  /** The parsed response body. JSON-decoded by default; `undefined` for an empty body. */
  data: T;
  /** The raw response body as text. Cached after the first call. */
  text(): Promise<string>;
  /** The raw response body parsed as JSON. Cached after the first call. */
  json<U = T>(): Promise<U>;
}

/**
 * The universal HTTP client contract — a thin wrapper over the global `fetch`. `request` is
 * the primitive; the verb helpers are sugar over it. Mirrors the Go platform's client, far
 * lighter: no middleware stack, just fetch plus an OTel span and structured logging.
 */
export interface HttpClient {
  request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>>;
  get<T = unknown>(url: string, opts?: RequestOptions): Promise<HttpResponse<T>>;
  post<T = unknown>(
    url: string,
    body?: unknown,
    opts?: RequestOptions,
  ): Promise<HttpResponse<T>>;
  put<T = unknown>(
    url: string,
    body?: unknown,
    opts?: RequestOptions,
  ): Promise<HttpResponse<T>>;
  patch<T = unknown>(
    url: string,
    body?: unknown,
    opts?: RequestOptions,
  ): Promise<HttpResponse<T>>;
  delete<T = unknown>(url: string, opts?: RequestOptions): Promise<HttpResponse<T>>;
}

/**
 * Raised for a non-2xx response when the caller opts into `throwOnError`, and the type thrown
 * by {@link assertOk}. Carries the offending {@link HttpResponse} so callers can inspect the
 * status and body without re-issuing the request.
 */
export class HttpError extends PlatformError {
  readonly status: number;
  readonly response: HttpResponse<unknown>;

  constructor(response: HttpResponse<unknown>) {
    super(
      "httpclient/http-error",
      `HTTP ${String(response.status)} ${response.statusText}`.trimEnd(),
    );
    this.name = "HttpError";
    this.status = response.status;
    this.response = response;
  }
}

/**
 * Returns the response when `ok`, otherwise throws an {@link HttpError}. The opt-in escape
 * hatch for callers that want exceptions instead of inspecting `ok` — the analogue of Go's
 * `resp.Error()`/status checks.
 */
export function assertOk<T>(response: HttpResponse<T>): HttpResponse<T> {
  if (!response.ok) {
    throw new HttpError(response);
  }
  return response;
}
