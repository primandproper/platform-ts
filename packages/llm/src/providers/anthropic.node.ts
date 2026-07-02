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
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(options: AnthropicLLMProviderOptions, deps: ObservabilityDeps = {}) {
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

    const response = await this.#fetch(this.#baseUrl, {
      method: "POST",
      headers: {
        "x-api-key": this.#apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      this.#logger.error(
        `anthropic completion failed with status ${String(response.status)}`,
      );
      throw new Error(`anthropic request failed: ${String(response.status)} ${text}`);
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
      result.usage = {
        inputTokens: data.usage.input_tokens ?? 0,
        outputTokens: data.usage.output_tokens ?? 0,
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
