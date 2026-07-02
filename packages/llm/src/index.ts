import type { ObservabilityDeps } from "@primandproper/observability";

import { LLMConfigSchema, type LLMConfigInput } from "./config.js";
import type { LLMProvider } from "./llm.js";
import { AnthropicLLMProvider } from "./providers/anthropic.node.js";
import { EchoLLMProvider } from "./providers/echo.js";
import { NoopLLMProvider } from "./providers/noop.js";
import { OpenAILLMProvider } from "./providers/openai.node.js";

export * from "./llm.js";
export * from "./config.js";
export { EchoLLMProvider } from "./providers/echo.js";
export { NoopLLMProvider } from "./providers/noop.js";
export {
  AnthropicLLMProvider,
  type AnthropicLLMProviderOptions,
  type FetchLike,
} from "./providers/anthropic.node.js";
export {
  OpenAILLMProvider,
  type OpenAILLMProviderOptions,
} from "./providers/openai.node.js";

/**
 * Validates config and returns the matching {@link LLMProvider}. Mirrors the Go platform's
 * `ProvideLLM`. Supports `echo` (default, zero-config), `noop`, `anthropic`, and `openai`.
 */
export function provideLLM(
  config?: LLMConfigInput,
  deps?: ObservabilityDeps,
): LLMProvider {
  const cfg = LLMConfigSchema.parse(config ?? {});
  switch (cfg.provider) {
    case "echo":
      return new EchoLLMProvider();
    case "noop":
      return new NoopLLMProvider();
    case "anthropic":
      // superRefine guarantees this, but narrow for the type checker.
      if (cfg.anthropic === undefined) {
        throw new Error("anthropic config is required when provider is 'anthropic'");
      }
      return new AnthropicLLMProvider(
        {
          apiKey: cfg.anthropic.apiKey,
          model: cfg.anthropic.model,
          baseUrl: cfg.anthropic.baseUrl,
          maxTokens: cfg.anthropic.maxTokens,
        },
        deps,
      );
    case "openai":
      if (cfg.openai === undefined) {
        throw new Error("openai config is required when provider is 'openai'");
      }
      return new OpenAILLMProvider(
        {
          apiKey: cfg.openai.apiKey,
          model: cfg.openai.model,
          baseUrl: cfg.openai.baseUrl,
          maxTokens: cfg.openai.maxTokens,
        },
        deps,
      );
  }
}
