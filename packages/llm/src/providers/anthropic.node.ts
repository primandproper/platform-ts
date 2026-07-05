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

/** The slice of `fetch` the provider relies on. Injectable so tests need no network. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Construction options for {@link AnthropicLLMProvider}. */
export interface AnthropicLLMProviderOptions {
  /** The Anthropic API key. Read from config; never hardcoded or read from the environment. */
  apiKey: string;
  /** The default model when a request omits one. */
  model: string;
  /** The Messages API endpoint. */
  baseUrl: string;
  /** The default `max_tokens` when a request omits one. Anthropic requires this field. */
  maxTokens: number;
  /** Per-completion deadline in milliseconds; `0` disables it. Defaults to 30s. */
  timeoutMs?: number;
  /** Optional retry policy for transient failures (network/timeout, 429/5xx). Off by default. */
  retry?: RetryConfig | undefined;
  /** The `fetch` implementation. Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
}

const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicResponseBody {
  content?: AnthropicContentBlock[];
  model?: string;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * A zero-dependency {@link LLMProvider} over the Anthropic Messages REST API, built on the
 * global `fetch`. Anthropic requires `max_tokens` and does not accept a `system` role inside
 * `messages` — any `system` message (and the request's top-level `system`) is folded into the
 * top-level `system` field, leaving only `user`/`assistant` roles in `messages`.
 */
export class AnthropicLLMProvider implements LLMProvider {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #maxTokens: number;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #retry: Policy | undefined;
  readonly #observer: Observer;
  readonly #tokens: TokenInstruments;

  constructor(options: AnthropicLLMProviderOptions, deps: ObservabilityDeps = {}) {
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
      const { messages, system } = splitSystem(request.messages, request.system);

      const body: {
        model: string;
        max_tokens: number;
        messages: Message[];
        system?: string;
        temperature?: number;
      } = {
        model,
        max_tokens: request.maxTokens ?? this.#maxTokens,
        messages,
      };
      if (system !== "") {
        body.system = system;
      }
      if (request.temperature !== undefined) {
        body.temperature = request.temperature;
      }

      const response = await resilientFetch(
        (signal) =>
          this.#fetch(this.#baseUrl, {
            method: "POST",
            headers: {
              "x-api-key": this.#apiKey,
              "anthropic-version": ANTHROPIC_VERSION,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
            ...(signal === undefined ? {} : { signal }),
          }),
        { timeoutMs: this.#timeoutMs, retry: this.#retry, signal: request.signal },
      );

      if (!response.ok) {
        const text = await response.text();
        const requestId = requestIdFromResponse(response, "request-id", "x-request-id");
        if (requestId !== undefined) {
          op.set("requestId", requestId);
        }
        throw op.error(
          new Error(`anthropic request failed: ${String(response.status)} ${text}`),
          `anthropic completion failed with status ${String(response.status)}`,
        );
      }

      const data = (await response.json()) as AnthropicResponseBody;
      const text = (data.content ?? [])
        .filter((block) => block.type === "text" && block.text !== undefined)
        .map((block) => block.text ?? "")
        .join("");

      const result: CompletionResponse = { text, model: data.model ?? model };
      if (data.stop_reason !== undefined) {
        result.stopReason = data.stop_reason;
      }
      if (data.usage !== undefined) {
        const usage = {
          inputTokens: data.usage.input_tokens ?? 0,
          outputTokens: data.usage.output_tokens ?? 0,
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
    const { messages, system } = splitSystem(request.messages, request.system);

    const body: {
      model: string;
      max_tokens: number;
      messages: Message[];
      stream: true;
      system?: string;
      temperature?: number;
    } = {
      model,
      max_tokens: request.maxTokens ?? this.#maxTokens,
      messages,
      stream: true,
    };
    if (system !== "") {
      body.system = system;
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
        "x-api-key": this.#apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`anthropic stream failed: ${String(response.status)} ${text}`);
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: string | undefined;
    for await (const data of sseDataLines(response.body)) {
      const event = JSON.parse(data) as AnthropicStreamEvent;
      switch (event.type) {
        case "message_start":
          inputTokens = event.message?.usage?.input_tokens ?? inputTokens;
          break;
        case "content_block_delta":
          if (event.delta?.type === "text_delta") {
            yield { delta: event.delta.text ?? "" };
          }
          break;
        case "message_delta":
          stopReason = event.delta?.stop_reason ?? stopReason;
          outputTokens = event.usage?.output_tokens ?? outputTokens;
          break;
        default:
          break;
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
   * Validates reachability and the API key against Anthropic's free, authenticated
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
            headers: {
              "x-api-key": this.#apiKey,
              "anthropic-version": ANTHROPIC_VERSION,
            },
            ...(signal === undefined ? {} : { signal }),
          }),
        { timeoutMs: this.#timeoutMs, retry: this.#retry },
      );
      if (!response.ok) {
        const text = await response.text();
        throw op.error(
          new Error(`anthropic ping failed: ${String(response.status)} ${text}`),
          `anthropic ping failed with status ${String(response.status)}`,
        );
      }
    });
  }
}

/** The slice of Anthropic's `message_*`/`content_block_delta` stream events this provider reads. */
interface AnthropicStreamEvent {
  type?: string;
  delta?: { type?: string; text?: string; stop_reason?: string };
  message?: { usage?: { input_tokens?: number } };
  usage?: { output_tokens?: number };
}

/**
 * Splits a message list into Anthropic's shape: `system` messages and the request's top-level
 * `system` are concatenated into a single top-level system string, and only `user`/`assistant`
 * roles remain in `messages`.
 */
function splitSystem(
  messages: Message[],
  topLevelSystem: string | undefined,
): { messages: Message[]; system: string } {
  const systemParts: string[] = [];
  if (topLevelSystem !== undefined && topLevelSystem !== "") {
    systemParts.push(topLevelSystem);
  }

  const rest: Message[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
    } else {
      rest.push(message);
    }
  }

  return { messages: rest, system: systemParts.join("\n\n") };
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
