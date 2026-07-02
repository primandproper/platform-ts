import { type Tracer } from "@opentelemetry/api";
import {
  makeRecordingObserver,
  type Logger,
  type TracerProvider,
} from "@primandproper/observability";
import { describe, expect, it, vi } from "vitest";

import { assertOk, HttpError } from "./httpclient.js";
import { FetchHttpClient, type FetchLike } from "./providers/fetch.js";

/** Records the args a request was made with so assertions can inspect them. */
interface Capture {
  url: string;
  init: RequestInit;
}

/** Builds a fake `fetch` that records its call and returns the given response. */
function fakeFetch(response: Response): { fetch: FetchLike; calls: Capture[] } {
  const calls: Capture[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(response);
  };
  return { fetch, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A tracer provider whose active span captures the attributes and statuses set on it. */
function recordingTracerProvider(): {
  provider: TracerProvider;
  attributes: [string, unknown][];
  statuses: { code: number }[];
} {
  const attributes: [string, unknown][] = [];
  const statuses: { code: number }[] = [];
  const span = {
    spanContext: vi.fn(),
    setAttribute: (key: string, value: unknown) => {
      attributes.push([key, value]);
      return span;
    },
    setAttributes: vi.fn(),
    addEvent: vi.fn(),
    addLink: vi.fn(),
    addLinks: vi.fn(),
    setStatus: (status: { code: number }) => {
      statuses.push(status);
      return span;
    },
    updateName: vi.fn(),
    end: vi.fn(),
    isRecording: vi.fn(() => true),
    recordException: vi.fn(),
  };
  const tracer = {
    startSpan: vi.fn(),
    startActiveSpan: (_name: string, ...rest: unknown[]): unknown => {
      const fn = rest[rest.length - 1] as (s: typeof span) => unknown;
      return fn(span);
    },
  } as unknown as Tracer;
  const provider: TracerProvider = { getTracer: () => tracer };
  return { provider, attributes, statuses };
}

/** A logger whose `warn`/`error` calls are recorded; chainable methods return itself. */
function recordingLogger(): {
  logger: Logger;
  warns: string[];
  errors: string[];
} {
  const warns: string[] = [];
  const errors: string[] = [];
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (message) => {
      warns.push(message);
    },
    error: (message) => {
      errors.push(message);
    },
    with: () => logger,
    child: () => logger,
    withSpan: () => logger,
  };
  return { logger, warns, errors };
}

describe("FetchHttpClient", () => {
  it("resolves a relative URL against baseUrl", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({}));
    const client = new FetchHttpClient({
      baseUrl: "https://api.example.com/v1",
      headers: {},
      timeoutMs: 0,
      fetch,
    });

    await client.get("users/42");

    expect(calls[0]?.url).toBe("https://api.example.com/v1/users/42");
  });

  it("leaves an absolute URL untouched", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({}));
    const client = new FetchHttpClient({
      baseUrl: "https://api.example.com",
      headers: {},
      timeoutMs: 0,
      fetch,
    });

    await client.get("https://other.example.com/thing");

    expect(calls[0]?.url).toBe("https://other.example.com/thing");
  });

  it("appends query parameters", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({}));
    const client = new FetchHttpClient({
      baseUrl: "https://api.example.com",
      headers: {},
      timeoutMs: 0,
      fetch,
    });

    await client.get("search", { query: { q: "cats", page: 2 } });

    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.get("q")).toBe("cats");
    expect(url.searchParams.get("page")).toBe("2");
  });

  it("merges per-request headers over the defaults", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({}));
    const client = new FetchHttpClient({
      headers: { authorization: "Bearer base", "x-default": "1" },
      timeoutMs: 0,
      fetch,
    });

    await client.get("https://api.example.com/x", {
      headers: { authorization: "Bearer override" },
    });

    const headers = calls[0]?.init.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer override");
    expect(headers.get("x-default")).toBe("1");
  });

  it("JSON-encodes an object body and sets content-type", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({}));
    const client = new FetchHttpClient({ headers: {}, timeoutMs: 0, fetch });

    await client.post("https://api.example.com/x", { name: "ada" });

    expect(calls[0]?.init.body).toBe('{"name":"ada"}');
    const headers = calls[0]?.init.headers as Headers;
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("does not re-encode a string body", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({}));
    const client = new FetchHttpClient({ headers: {}, timeoutMs: 0, fetch });

    await client.post("https://api.example.com/x", "raw-payload");

    expect(calls[0]?.init.body).toBe("raw-payload");
  });

  it("parses a JSON body into typed data", async () => {
    interface User {
      id: number;
      name: string;
    }
    const { fetch } = fakeFetch(jsonResponse({ id: 1, name: "grace" }));
    const client = new FetchHttpClient({ headers: {}, timeoutMs: 0, fetch });

    const res = await client.get<User>("https://api.example.com/users/1");

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.data).toStrictEqual({ id: 1, name: "grace" });
    expect(await res.text()).toBe('{"id":1,"name":"grace"}');
  });

  it("returns undefined data for an empty body", async () => {
    const { fetch } = fakeFetch(new Response(null, { status: 204 }));
    const client = new FetchHttpClient({ headers: {}, timeoutMs: 0, fetch });

    const res = await client.delete("https://api.example.com/x");

    expect(res.ok).toBe(true);
    expect(res.data).toBeUndefined();
  });

  it("returns ok=false on a non-2xx response without throwing", async () => {
    const { fetch } = fakeFetch(jsonResponse({ error: "nope" }, 404));
    const client = new FetchHttpClient({ headers: {}, timeoutMs: 0, fetch });

    const res = await client.get("https://api.example.com/missing");

    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.data).toStrictEqual({ error: "nope" });
  });

  it("rejects with HttpError when throwOnError is set", async () => {
    const { fetch } = fakeFetch(jsonResponse({ error: "nope" }, 500));
    const client = new FetchHttpClient({ headers: {}, timeoutMs: 0, fetch });

    await expect(
      client.get("https://api.example.com/x", { throwOnError: true }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("assertOk throws for a non-2xx response and passes a 2xx through", async () => {
    const { fetch } = fakeFetch(jsonResponse({ ok: true }, 200));
    const client = new FetchHttpClient({ headers: {}, timeoutMs: 0, fetch });

    const res = await client.get("https://api.example.com/x");
    expect(() => assertOk(res)).not.toThrow();

    const { fetch: failFetch } = fakeFetch(jsonResponse({}, 403));
    const failClient = new FetchHttpClient({
      headers: {},
      timeoutMs: 0,
      fetch: failFetch,
    });
    const failRes = await failClient.get("https://api.example.com/x");
    expect(() => assertOk(failRes)).toThrow(HttpError);
    try {
      assertOk(failRes);
    } catch (err) {
      expect((err as HttpError).status).toBe(403);
      expect((err as HttpError).response.status).toBe(403);
    }
  });

  it("wires a timeout signal into the request", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({}));
    const client = new FetchHttpClient({
      headers: {},
      timeoutMs: 5_000,
      fetch,
    });

    await client.get("https://api.example.com/x");

    const signal = calls[0]?.init.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it("combines a caller signal with the timeout signal", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({}));
    const client = new FetchHttpClient({ headers: {}, timeoutMs: 5_000, fetch });
    const controller = new AbortController();

    const promise = client.get("https://api.example.com/x", {
      signal: controller.signal,
    });
    await promise;

    const signal = calls[0]?.init.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    // Aborting the caller's controller aborts the combined signal too.
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });

  it("passes no signal when the timeout is disabled and no signal is given", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({}));
    const client = new FetchHttpClient({ headers: {}, timeoutMs: 0, fetch });

    await client.get("https://api.example.com/x");

    expect(calls[0]?.init.signal).toBeUndefined();
  });

  it("retries a failing request when a retry policy is configured", async () => {
    let attempts = 0;
    const fetch: FetchLike = () => {
      attempts += 1;
      if (attempts < 3) {
        return Promise.reject(new Error("network down"));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    };
    const client = new FetchHttpClient({
      headers: {},
      timeoutMs: 0,
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      fetch,
    });

    const res = await client.get("https://api.example.com/x");

    expect(attempts).toBe(3);
    expect(res.ok).toBe(true);
  });

  it("falls back to globalThis.fetch when none is injected", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ via: "global" }));
    const client = new FetchHttpClient({ headers: {}, timeoutMs: 0 });

    const res = await client.get<{ via: string }>("https://api.example.com/x");

    expect(res.data).toStrictEqual({ via: "global" });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("records request and response attributes on the span", async () => {
    const { fetch } = fakeFetch(jsonResponse({ ok: true }, 201));
    const { provider, attributes } = recordingTracerProvider();
    const client = new FetchHttpClient(
      { headers: {}, timeoutMs: 0, fetch },
      { tracer: provider },
    );

    await client.post("https://api.example.com/x", { name: "ada" });

    expect(attributes).toContainEqual(["http.request.method", "POST"]);
    expect(attributes).toContainEqual(["url.full", "https://api.example.com/x"]);
    expect(attributes).toContainEqual(["http.response.status_code", 201]);
  });

  it("sets ERROR span status and warns on a non-2xx response", async () => {
    const { fetch } = fakeFetch(jsonResponse({ error: "nope" }, 503));
    const { provider, statuses } = recordingTracerProvider();
    const { logger, warns } = recordingLogger();
    const client = new FetchHttpClient(
      { headers: {}, timeoutMs: 0, fetch },
      { tracer: provider, logger },
    );

    await client.get("https://api.example.com/missing");

    expect(statuses).toContainEqual({ code: 2 }); // SpanStatusCode.ERROR
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("503");
  });

  it("logs an error when the request throws", async () => {
    const fetch: FetchLike = () => Promise.reject(new Error("network down"));
    const { logger, errors } = recordingLogger();
    const client = new FetchHttpClient({ headers: {}, timeoutMs: 0, fetch }, { logger });

    await expect(client.get("https://api.example.com/x")).rejects.toThrow("network down");

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("request to https://api.example.com/x failed");
  });

  it("uses an injected observer and records what the request observes", async () => {
    const { fetch } = fakeFetch(jsonResponse({ ok: true }, 200));
    const observer = makeRecordingObserver();
    const client = new FetchHttpClient(
      { headers: {}, timeoutMs: 0, fetch },
      { observer },
    );

    await client.get("https://api.example.com/x");

    expect(observer.data()).toMatchObject({
      "http.request.method": "GET",
      "url.full": "https://api.example.com/x",
      "http.response.status_code": 200,
    });
    expect(
      observer.observedInOrder("http.request.method", "http.response.status_code"),
    ).toBe(true);
  });
});
