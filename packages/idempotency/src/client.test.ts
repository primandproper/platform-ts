import { describe, expect, it } from "vitest";

import { idempotentFetch } from "./client.js";
import { IDEMPOTENCY_KEY_HEADER, parseIdempotencyKey } from "./key.js";

/** Captures what the wrapper would have sent, without a network. */
function recordingFetch(): {
  fetch: typeof fetch;
  calls: { input: RequestInfo | URL; init: RequestInit | undefined }[];
} {
  const calls: { input: RequestInfo | URL; init: RequestInit | undefined }[] = [];
  return {
    calls,
    fetch: (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ input, init });
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  };
}

/** The key the wrapper actually put on the wire for call `index`. */
function sentKey(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get(IDEMPOTENCY_KEY_HEADER);
}

describe("idempotentFetch", () => {
  it("stamps the key it minted", async () => {
    const spy = recordingFetch();
    const send = idempotentFetch({ fetch: spy.fetch });

    await send("/charges", { method: "POST" });

    expect(sentKey(spy.calls[0]?.init)).toBe(send.key);
  });

  it("sends the same key on every attempt — the whole point of binding it to the wrapper", async () => {
    const spy = recordingFetch();
    const send = idempotentFetch({ fetch: spy.fetch });

    // Standing in for a retry loop: the wrapper is built once, outside it.
    await send("/charges", { method: "POST", body: "{}" });
    await send("/charges", { method: "POST", body: "{}" });

    expect(sentKey(spy.calls[0]?.init)).toBe(sentKey(spy.calls[1]?.init));
  });

  it("leaves safe methods alone", async () => {
    const spy = recordingFetch();
    const send = idempotentFetch({ fetch: spy.fetch });

    await send("/charges");
    await send("/charges", { method: "GET" });

    expect(sentKey(spy.calls[0]?.init)).toBeNull();
    expect(sentKey(spy.calls[1]?.init)).toBeNull();
  });

  it("never overrides a key the caller set itself", async () => {
    const spy = recordingFetch();
    const send = idempotentFetch({ fetch: spy.fetch });

    await send("/charges", {
      method: "POST",
      headers: { [IDEMPOTENCY_KEY_HEADER]: "caller-owned" },
    });

    expect(sentKey(spy.calls[0]?.init)).toBe("caller-owned");
  });

  it("reuses a supplied key instead of minting one", () => {
    const key = parseIdempotencyKey("resumed-operation");
    expect(idempotentFetch({ key }).key).toBe(key);
  });

  it("does not mutate the init the caller passed", async () => {
    const spy = recordingFetch();
    const send = idempotentFetch({ fetch: spy.fetch });
    // The shape a retry loop produces: one init object reused for every attempt.
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "text/plain" },
    };

    await send("/charges", init);

    expect(new Headers(init.headers).has(IDEMPOTENCY_KEY_HEADER)).toBe(false);
    expect(sentKey(spy.calls[0]?.init)).toBe(send.key);
    expect(new Headers(spy.calls[0]?.init?.headers).get("content-type")).toBe(
      "text/plain",
    );
  });

  it("keeps a Request's own headers when no init headers are given", async () => {
    const spy = recordingFetch();
    const send = idempotentFetch({ fetch: spy.fetch });

    await send(
      new Request("https://api.example.com/charges", {
        method: "POST",
        headers: { "x-trace": "abc" },
      }),
    );

    expect(new Headers(spy.calls[0]?.init?.headers).get("x-trace")).toBe("abc");
    expect(sentKey(spy.calls[0]?.init)).toBe(send.key);
  });

  it("honours a Request's own already-set key", async () => {
    const spy = recordingFetch();
    const send = idempotentFetch({ fetch: spy.fetch });

    await send(
      new Request("https://api.example.com/charges", {
        method: "POST",
        headers: { [IDEMPOTENCY_KEY_HEADER]: "caller-owned" },
      }),
    );

    expect(spy.calls[0]?.init).toBeUndefined();
  });

  it("takes a custom header name and method set", async () => {
    const spy = recordingFetch();
    const send = idempotentFetch({
      fetch: spy.fetch,
      headerName: "X-Idempotency",
      methods: ["GET"],
    });

    await send("/charges");
    await send("/charges", { method: "POST" });

    expect(new Headers(spy.calls[0]?.init?.headers).get("X-Idempotency")).toBe(send.key);
    expect(spy.calls[1]?.init?.headers).toBeUndefined();
  });
});
