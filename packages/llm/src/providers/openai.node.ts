import {
  makeObserver,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";
import type { Policy, RetryConfig } from "@primandproper/retry";

import type {
  CompletionChunk,
  CompletionRequest,
  CompletionResponse,
  LLMProvider,
  Message,
  Usage,
} from "../llm.js";

import type { FetchLike } from "./anthropic.node.js";
import {
  DEFAULT_LLM_TIMEOUT_MS,
  requestIdFromResponse,
  resilientFetch,
  retryPolicy,
  sseDataLines,
  tokenInstruments,
  type TokenInstruments,
} from "./support.js";

const o11yName = "llm";

/** Construction options for {@link OpenAILLMProvider}. */
export interface OpenAILLMProviderOptions {
  /** The OpenAI API key. Read from config; never hardcoded or read from the environment. */
  apiKey: string;
  /** The default model when a request omits one. */
  model: string;
  /** The Chat Completions endpoint. */
  baseUrl: string;
  /** The default `max_tokens` when a request omits one. */
  maxTokens: number;
  /** Per-completion deadline in milliseconds; `0` disables it. Defaults to 30s. */
  timeoutMs?: number;
  /** Optional retry policy for transient failures (network/timeout, 429/5xx). Off by default. */
  retry?: RetryConfig | undefined;
  /** The `fetch` implementation. Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
}

interface OpenAIChoice {
  message?: { content?: string };
  finish_reason?: string;
}

interface OpenAIResponseBody {
  choices?: OpenAIChoice[];
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * A zero-dependency {@link LLMProvider} over the OpenAI Chat Completions REST API, built on
 * the global `fetch`. OpenAI accepts a `system` role inside `messages`, so the request's
 * top-level `system` is prepended as a `{ role: "system" }` message.
 */
export class OpenAILLMProvider implements LLMProvider {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #maxTokens: number;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #retry: Policy | undefined;
  readonly #observer: Observer;
  readonly #tokens: TokenInstruments;

  constructor(options: OpenAILLMProviderOptions, deps: ObservabilityDeps = {}) {
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#baseUrl = options.baseUrl;
    this.#maxTokens = options.maxTokens;
    this.#fetch = resolveFetch(options.fetch);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#retry = retryPolicy(options.retry, this.#observer.logger());
    this.#tokens = tokenInstruments(o11yName, deps);
  }

  complete(request: CompletionRequest): Promise<CompletionResponse> {
    return this.#observer.run("complete", async (op) => {
      const model = request.model ?? this.#model;
      op.set("model", model);

      const messages: Message[] =
        request.system !== undefined && request.system !== ""
          ? [{ role: "system", content: request.system }, ...request.messages]
          : request.messages;

      const body: {
        model: string;
        messages: Message[];
        max_tokens?: number;
        temperature?: number;
      } = { model, messages };
      const maxTokens = request.maxTokens ?? this.#maxTokens;
      if (maxTokens > 0) {
        body.max_tokens = maxTokens;
      }
      if (request.temperature !== undefined) {
        body.temperature = request.temperature;
      }

      const response = await resilientFetch(
        (signal) =>
          this.#fetch(this.#baseUrl, {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.#apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
            ...(signal === undefined ? {} : { signal }),
          }),
        { timeoutMs: this.#timeoutMs, retry: this.#retry, signal: request.signal },
      );

      if (!response.ok) {
        const text = await response.text();
        const requestId = requestIdFromResponse(response, "x-request-id", "request-id");
        if (requestId !== undefined) {
          op.set("requestId", requestId);
        }
        throw op.error(
          new Error(`openai request failed: ${String(response.status)} ${text}`),
          `openai completion failed with status ${String(response.status)}`,
        );
      }

      const data = (await response.json()) as OpenAIResponseBody;
      const choice = (data.choices ?? [])[0];

      const result: CompletionResponse = {
        text: choice?.message?.content ?? "",
        model: data.model ?? model,
      };
      if (choice?.finish_reason !== undefined) {
        result.stopReason = choice.finish_reason;
      }
      if (data.usage !== undefined) {
        const usage = {
          inputTokens: data.usage.prompt_tokens ?? 0,
          outputTokens: data.usage.completion_tokens ?? 0,
        };
        result.usage = usage;
        op.set("llm.tokens.input", usage.inputTokens).set(
          "llm.tokens.output",
          usage.outputTokens,
        );
        this.#tokens.inputTokens.add(usage.inputTokens, { model });
        this.#tokens.outputTokens.add(usage.outputTokens, { model });
      }
      return result;
    });
  }

  async *completeStream(request: CompletionRequest): AsyncGenerator<CompletionChunk> {
    const model = request.model ?? this.#model;
    const messages: Message[] =
      request.system !== undefined && request.system !== ""
        ? [{ role: "system", content: request.system }, ...request.messages]
        : request.messages;

    const body: {
      model: string;
      messages: Message[];
      stream: true;
      stream_options: { include_usage: true };
      max_tokens?: number;
      temperature?: number;
    } = {
      model,
      messages,
      stream: true,
      // Ask OpenAI to emit a final usage-only chunk; without this, streamed responses omit usage.
      stream_options: { include_usage: true },
    };
    const maxTokens = request.maxTokens ?? this.#maxTokens;
    if (maxTokens > 0) {
      body.max_tokens = maxTokens;
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    // Streaming imposes no timeout — a long generation legitimately outlives one; only the
    // caller's signal cancels it. Retry is likewise inapplicable mid-stream (no resume point).
    this.#observer.logger().debug("streaming completion", { model });
    const response = await this.#fetch(this.#baseUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`openai stream failed: ${String(response.status)} ${text}`);
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: string | undefined;
    for await (const data of sseDataLines(response.body)) {
      const event = JSON.parse(data) as OpenAIStreamEvent;
      const choice = event.choices?.[0];
      const content = choice?.delta?.content;
      if (content !== undefined && content !== "") {
        yield { delta: content };
      }
      if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
        stopReason = choice.finish_reason;
      }
      if (event.usage !== undefined) {
        inputTokens = event.usage.prompt_tokens ?? inputTokens;
        outputTokens = event.usage.completion_tokens ?? outputTokens;
      }
    }

    this.#tokens.inputTokens.add(inputTokens, { model });
    this.#tokens.outputTokens.add(outputTokens, { model });
    const usage: Usage = { inputTokens, outputTokens };
    yield stopReason === undefined
      ? { delta: "", usage }
      : { delta: "", stopReason, usage };
  }

  /**
   * Validates reachability and the API key against OpenAI's free, authenticated
   * `GET /v1/models` endpoint (no tokens billed). Rejects when the key is invalid or the API is
   * unreachable, so a caller can fail fast at startup instead of on the first real completion.
   */
  ping(): Promise<void> {
    return this.#observer.run("ping", async (op) => {
      const url = new URL("/v1/models", this.#baseUrl).toString();
      const response = await resilientFetch(
        (signal) =>
          this.#fetch(url, {
            method: "GET",
            headers: { authorization: `Bearer ${this.#apiKey}` },
            ...(signal === undefined ? {} : { signal }),
          }),
        { timeoutMs: this.#timeoutMs, retry: this.#retry },
      );
      if (!response.ok) {
        const text = await response.text();
        throw op.error(
          new Error(`openai ping failed: ${String(response.status)} ${text}`),
          `openai ping failed with status ${String(response.status)}`,
        );
      }
    });
  }
}

/** The slice of OpenAI's chat-completion stream chunks this provider reads. */
interface OpenAIStreamEvent {
  choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function resolveFetch(fetch?: FetchLike): FetchLike {
  if (fetch !== undefined) {
    return fetch;
  }
  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis);
  }
  throw new Error("no fetch implementation available; pass one via options.fetch");
}
