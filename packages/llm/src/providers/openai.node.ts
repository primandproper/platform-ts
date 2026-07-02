import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type {
  CompletionRequest,
  CompletionResponse,
  LLMProvider,
  Message,
} from "../llm.js";

import type { FetchLike } from "./anthropic.node.js";

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
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(options: OpenAILLMProviderOptions, deps: ObservabilityDeps = {}) {
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#baseUrl = options.baseUrl;
    this.#maxTokens = options.maxTokens;
    this.#fetch = resolveFetch(options.fetch);
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const model = request.model ?? this.#model;

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

    const response = await this.#fetch(this.#baseUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      this.#logger.error(
        `openai completion failed with status ${String(response.status)}`,
      );
      throw new Error(`openai request failed: ${String(response.status)} ${text}`);
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
      result.usage = {
        inputTokens: data.usage.prompt_tokens ?? 0,
        outputTokens: data.usage.completion_tokens ?? 0,
      };
    }
    return result;
  }

  /**
   * Resolves immediately without calling the API — a reachability probe here would burn an
   * API call for no signal. Construction validates the configuration that matters.
   */
  ping(): Promise<void> {
    return Promise.resolve();
  }
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
