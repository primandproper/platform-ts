import { makeRecordingObserver } from "@primandproper/observability";
import { describe, expect, it, vi } from "vitest";

import { AnthropicLLMProvider, type FetchLike } from "./providers/anthropic.node.js";
import { EchoLLMProvider } from "./providers/echo.js";
import { NoopLLMProvider } from "./providers/noop.js";
import { OpenAILLMProvider } from "./providers/openai.node.js";

import { provideLLM, type Message } from "./index.js";

/**
 * Builds a Response-like value with a stubbed `json()` / `text()` for an injected fetch.
 * `headers` seeds a `headers.get(name)` so the request-id capture path can be exercised.
 */
function fakeResponse(
  ok: boolean,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok,
    status,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

/** A meter provider whose counters record every add(), keyed by instrument name. */
function recordingMetrics(): {
  metrics: never;
  adds: { name: string; value: number; attrs?: unknown }[];
} {
  const adds: { name: string; value: number; attrs?: unknown }[] = [];
  const meter = {
    createCounter: (name: string) => ({
      add: (value: number, attrs?: unknown) => adds.push({ name, value, attrs }),
    }),
    createUpDownCounter: () => ({ add: () => undefined }),
    createHistogram: () => ({ record: () => undefined }),
    createGauge: () => ({ record: () => undefined }),
  };
  return { metrics: { getMeter: () => meter } as unknown as never, adds };
}

describe("EchoLLMProvider", () => {
  it("echoes the last user message", async () => {
    const provider = new EchoLLMProvider();
    const messages: Message[] = [
      { role: "system", content: "be terse" },
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
    ];

    const response = await provider.complete({ messages });

    expect(response.text).toBe("echo: second");
    expect(response.model).toBe("echo");
  });

  it("pings without throwing", async () => {
    await expect(new EchoLLMProvider().ping()).resolves.toBeUndefined();
  });
});

describe("NoopLLMProvider", () => {
  it("returns empty text", async () => {
    const response = await new NoopLLMProvider().complete();
    expect(response.text).toBe("");
  });
});

describe("REST provider ping validates the key against GET /v1/models", () => {
  it("Anthropic ping GETs /v1/models with the key and resolves on 200", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(fakeResponse(true, 200, { data: [] }));
    const provider = new AnthropicLLMProvider({
      apiKey: "secret-key",
      model: "claude-sonnet-4-6",
      baseUrl: "https://api.anthropic.com/v1/messages",
      maxTokens: 1024,
      fetch,
    });
    await expect(provider.ping()).resolves.toBeUndefined();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/models");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("secret-key");
  });

  it("Anthropic ping rejects on a 401", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(fakeResponse(false, 401, "unauthorized"));
    const provider = new AnthropicLLMProvider({
      apiKey: "bad-key",
      model: "claude-sonnet-4-6",
      baseUrl: "https://api.anthropic.com/v1/messages",
      maxTokens: 1024,
      fetch,
    });
    await expect(provider.ping()).rejects.toThrow(/401/);
  });

  it("OpenAI ping GETs /v1/models with a bearer token and resolves on 200", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(fakeResponse(true, 200, { data: [] }));
    const provider = new OpenAILLMProvider({
      apiKey: "secret-key",
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1/chat/completions",
      maxTokens: 1024,
      fetch,
    });
    await expect(provider.ping()).resolves.toBeUndefined();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/models");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer secret-key",
    );
  });

  it("OpenAI ping rejects on a 401", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(fakeResponse(false, 401, "unauthorized"));
    const provider = new OpenAILLMProvider({
      apiKey: "bad-key",
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1/chat/completions",
      maxTokens: 1024,
      fetch,
    });
    await expect(provider.ping()).rejects.toThrow(/401/);
  });
});

describe("AnthropicLLMProvider", () => {
  it("POSTs the right URL and headers, folds system, and concatenates content blocks", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      fakeResponse(true, 200, {
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );

    const provider = new AnthropicLLMProvider({
      apiKey: "secret-key",
      model: "claude-sonnet-4-6",
      baseUrl: "https://api.anthropic.com/v1/messages",
      maxTokens: 1024,
      fetch,
    });

    const response = await provider.complete({
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "hi" },
      ],
      system: "top-level system",
    });

    expect(response.text).toBe("Hello world");
    expect(response.model).toBe("claude-sonnet-4-6");
    expect(response.stopReason).toBe("end_turn");
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5 });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "x-api-key": "secret-key",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    });

    const body = JSON.parse(init.body as string) as {
      max_tokens: number;
      system: string;
      messages: Message[];
    };
    expect(body.max_tokens).toBe(1024);
    // The system Message is folded into the top-level `system` field, not sent as a role.
    expect(body.system).toBe("top-level system\n\nyou are helpful");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.messages.some((m) => m.role === "system")).toBe(false);
  });

  it("throws on a non-ok response", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(fakeResponse(false, 401, "unauthorized"));

    const provider = new AnthropicLLMProvider({
      apiKey: "bad",
      model: "claude-sonnet-4-6",
      baseUrl: "https://api.anthropic.com/v1/messages",
      maxTokens: 1024,
      fetch,
    });

    await expect(
      provider.complete({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/401/);
  });

  it("records token counters and the model on the span for a successful completion", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      fakeResponse(true, 200, {
        content: [{ type: "text", text: "hi" }],
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );
    const observer = makeRecordingObserver();
    const { metrics, adds } = recordingMetrics();

    const provider = new AnthropicLLMProvider(
      {
        apiKey: "k",
        model: "claude-sonnet-4-6",
        baseUrl: "https://api.anthropic.com/v1/messages",
        maxTokens: 1024,
        fetch,
      },
      { observer, metrics },
    );

    await provider.complete({ messages: [{ role: "user", content: "hi" }] });

    expect(adds).toContainEqual({
      name: "llm.tokens.input",
      value: 10,
      attrs: { model: "claude-sonnet-4-6" },
    });
    expect(adds).toContainEqual({
      name: "llm.tokens.output",
      value: 5,
      attrs: { model: "claude-sonnet-4-6" },
    });
    expect(observer.data()).toMatchObject({
      model: "claude-sonnet-4-6",
      "llm.tokens.input": 10,
      "llm.tokens.output": 5,
    });
  });

  it("captures the vendor request id on an error", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(
        fakeResponse(false, 401, "unauthorized", { "request-id": "req_abc123" }),
      );
    const observer = makeRecordingObserver();

    const provider = new AnthropicLLMProvider(
      {
        apiKey: "bad",
        model: "claude-sonnet-4-6",
        baseUrl: "https://api.anthropic.com/v1/messages",
        maxTokens: 1024,
        fetch,
      },
      { observer },
    );

    await expect(
      provider.complete({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/401/);

    expect(observer.data().requestId).toBe("req_abc123");
    expect(observer.errors).toHaveLength(1);
  });
});

describe("OpenAILLMProvider", () => {
  it("sends system as a message and maps choices[0]", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      fakeResponse(true, 200, {
        choices: [{ message: { content: "Hi there" }, finish_reason: "stop" }],
        model: "gpt-4o",
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      }),
    );

    const provider = new OpenAILLMProvider({
      apiKey: "sk-test",
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1/chat/completions",
      maxTokens: 1024,
      fetch,
    });

    const response = await provider.complete({
      messages: [{ role: "user", content: "hi" }],
      system: "be brief",
    });

    expect(response.text).toBe("Hi there");
    expect(response.model).toBe("gpt-4o");
    expect(response.stopReason).toBe("stop");
    expect(response.usage).toEqual({ inputTokens: 7, outputTokens: 3 });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.headers).toMatchObject({
      authorization: "Bearer sk-test",
      "content-type": "application/json",
    });

    const body = JSON.parse(init.body as string) as {
      max_tokens: number;
      messages: Message[];
    };
    expect(body.max_tokens).toBe(1024);
    // OpenAI accepts a system role: the top-level system is prepended as a message.
    expect(body.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
  });

  it("throws on a non-ok response", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(fakeResponse(false, 500, "server error"));

    const provider = new OpenAILLMProvider({
      apiKey: "sk-test",
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1/chat/completions",
      maxTokens: 1024,
      fetch,
    });

    await expect(
      provider.complete({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/500/);
  });

  it("records token counters and the model on the span for a successful completion", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      fakeResponse(true, 200, {
        choices: [{ message: { content: "Hi there" }, finish_reason: "stop" }],
        model: "gpt-4o",
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      }),
    );
    const observer = makeRecordingObserver();
    const { metrics, adds } = recordingMetrics();

    const provider = new OpenAILLMProvider(
      {
        apiKey: "sk-test",
        model: "gpt-4o",
        baseUrl: "https://api.openai.com/v1/chat/completions",
        maxTokens: 1024,
        fetch,
      },
      { observer, metrics },
    );

    await provider.complete({ messages: [{ role: "user", content: "hi" }] });

    expect(adds).toContainEqual({
      name: "llm.tokens.input",
      value: 7,
      attrs: { model: "gpt-4o" },
    });
    expect(adds).toContainEqual({
      name: "llm.tokens.output",
      value: 3,
      attrs: { model: "gpt-4o" },
    });
    expect(observer.data()).toMatchObject({
      model: "gpt-4o",
      "llm.tokens.input": 7,
      "llm.tokens.output": 3,
    });
  });

  it("captures the vendor request id on an error", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(
        fakeResponse(false, 500, "server error", { "x-request-id": "req_openai_9" }),
      );
    const observer = makeRecordingObserver();

    const provider = new OpenAILLMProvider(
      {
        apiKey: "sk-test",
        model: "gpt-4o",
        baseUrl: "https://api.openai.com/v1/chat/completions",
        maxTokens: 1024,
        fetch,
      },
      { observer },
    );

    await expect(
      provider.complete({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/500/);

    expect(observer.data().requestId).toBe("req_openai_9");
    expect(observer.errors).toHaveLength(1);
  });
});

describe("LLM resilience (timeout + retry)", () => {
  const base = {
    apiKey: "k",
    model: "claude-sonnet-4-6",
    baseUrl: "https://api.anthropic.com/v1/messages",
    maxTokens: 1024,
  };
  const ask = { messages: [{ role: "user" as const, content: "hi" }] };

  it("passes an abort signal into the completion fetch by default", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(fakeResponse(true, 200, { content: [], model: "m" }));
    const provider = new AnthropicLLMProvider({ ...base, fetch });

    await provider.complete(ask);

    expect(fetch.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  });

  it("sends no signal when the timeout is disabled", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(fakeResponse(true, 200, { content: [], model: "m" }));
    const provider = new AnthropicLLMProvider({ ...base, timeoutMs: 0, fetch });

    await provider.complete(ask);

    expect(fetch.mock.calls[0]?.[1].signal ?? undefined).toBeUndefined();
  });

  it("does not retry a 529 overload unless a retry policy is configured", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(fakeResponse(false, 529, "overloaded"));
    const provider = new AnthropicLLMProvider({ ...base, fetch });

    await expect(provider.complete(ask)).rejects.toThrow(/529/);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retries a 529 overload when a retry policy is configured, then succeeds", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(fakeResponse(false, 529, "overloaded"))
      .mockResolvedValueOnce(fakeResponse(true, 200, { content: [], model: "m" }));
    const provider = new AnthropicLLMProvider({
      ...base,
      retry: {
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: 0,
        maxElapsedMs: 0,
      },
      fetch,
    });

    await provider.complete(ask);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 400 even with a retry policy configured", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(fakeResponse(false, 400, "bad request"));
    const provider = new OpenAILLMProvider({
      apiKey: "k",
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1/chat/completions",
      maxTokens: 1024,
      retry: {
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: 0,
        maxElapsedMs: 0,
      },
      fetch,
    });

    await expect(provider.complete(ask)).rejects.toThrow(/400/);
    expect(fetch).toHaveBeenCalledOnce();
  });
});

/** Parses the JSON request body a mocked fetch was called with, typed for the fields we assert. */
function sentBody(fetch: ReturnType<typeof vi.fn<FetchLike>>): {
  stream?: boolean;
  stream_options?: unknown;
} {
  const body = fetch.mock.calls[0]?.[1].body;
  return JSON.parse(typeof body === "string" ? body : "{}") as {
    stream?: boolean;
    stream_options?: unknown;
  };
}

/** Builds a real streaming `Response` (a `ReadableStream` body) from SSE text. */
function sseResponse(body: string, status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

const anthropicSse = [
  "event: message_start",
  'data: {"type":"message_start","message":{"usage":{"input_tokens":7}}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}',
  "",
  "event: message_delta",
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
  "",
  "event: message_stop",
  'data: {"type":"message_stop"}',
  "",
].join("\n");

const openaiSse = [
  'data: {"choices":[{"delta":{"content":"Hello "},"finish_reason":null}]}',
  "",
  'data: {"choices":[{"delta":{"content":"world"},"finish_reason":null}]}',
  "",
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  "",
  'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}',
  "",
  "data: [DONE]",
  "",
].join("\n");

describe("LLM streaming (completeStream)", () => {
  const ask = { messages: [{ role: "user" as const, content: "hi" }] };

  it("echoes as a single delta then a terminal usage chunk", async () => {
    const chunks = [];
    for await (const chunk of new EchoLLMProvider().completeStream({
      messages: [{ role: "user", content: "hey" }],
    })) {
      chunks.push(chunk);
    }
    expect(chunks.map((c) => c.delta).join("")).toBe("echo: hey");
    expect(chunks.at(-1)?.usage).toBeDefined();
  });

  it("parses anthropic SSE deltas, stop reason, and usage", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(sseResponse(anthropicSse));
    const provider = new AnthropicLLMProvider({
      apiKey: "k",
      model: "claude-sonnet-4-6",
      baseUrl: "https://api.anthropic.com/v1/messages",
      maxTokens: 1024,
      fetch,
    });

    const chunks = [];
    for await (const chunk of provider.completeStream(ask)) {
      chunks.push(chunk);
    }

    expect(chunks.map((c) => c.delta).join("")).toBe("Hello world");
    expect(chunks.at(-1)?.stopReason).toBe("end_turn");
    expect(chunks.at(-1)?.usage).toStrictEqual({ inputTokens: 7, outputTokens: 3 });
    // The request asked the API to stream.
    expect(sentBody(fetch).stream).toBe(true);
  });

  it("parses openai SSE deltas, finish reason, and usage", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(sseResponse(openaiSse));
    const provider = new OpenAILLMProvider({
      apiKey: "k",
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1/chat/completions",
      maxTokens: 1024,
      fetch,
    });

    const chunks = [];
    for await (const chunk of provider.completeStream(ask)) {
      chunks.push(chunk);
    }

    expect(chunks.map((c) => c.delta).join("")).toBe("Hello world");
    expect(chunks.at(-1)?.stopReason).toBe("stop");
    expect(chunks.at(-1)?.usage).toStrictEqual({ inputTokens: 7, outputTokens: 3 });
    const sent = sentBody(fetch);
    expect(sent.stream).toBe(true);
    expect(sent.stream_options).toStrictEqual({ include_usage: true });
  });

  it("throws on a non-2xx streaming response", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response("nope", { status: 500 }));
    const provider = new AnthropicLLMProvider({
      apiKey: "k",
      model: "claude-sonnet-4-6",
      baseUrl: "https://api.anthropic.com/v1/messages",
      maxTokens: 1024,
      fetch,
    });

    await expect(async () => {
      for await (const chunk of provider.completeStream(ask)) {
        void chunk; // drain
      }
    }).rejects.toThrow(/500/);
  });
});

describe("provideLLM", () => {
  it("defaults to the echo provider", async () => {
    const provider = provideLLM();
    expect(provider).toBeInstanceOf(EchoLLMProvider);
    const response = await provider.complete({
      messages: [{ role: "user", content: "ping" }],
    });
    expect(response.text).toBe("echo: ping");
  });

  it("builds an anthropic provider from config", () => {
    const provider = provideLLM({
      provider: "anthropic",
      anthropic: { apiKey: "k" },
    });
    expect(provider).toBeInstanceOf(AnthropicLLMProvider);
  });

  it("rejects an anthropic provider without config", () => {
    expect(() => provideLLM({ provider: "anthropic" })).toThrow();
  });

  it("rejects an openai provider without config", () => {
    expect(() => provideLLM({ provider: "openai" })).toThrow();
  });
});
