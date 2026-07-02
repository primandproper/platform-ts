import { describe, expect, it, vi } from "vitest";

import { AnthropicLLMProvider, type FetchLike } from "./providers/anthropic.node.js";
import { EchoLLMProvider } from "./providers/echo.js";
import { NoopLLMProvider } from "./providers/noop.js";
import { OpenAILLMProvider } from "./providers/openai.node.js";

import { provideLLM, type Message } from "./index.js";

/** Builds a Response-like value with a stubbed `json()` / `text()` for an injected fetch. */
function fakeResponse(ok: boolean, status: number, body: unknown): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
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
