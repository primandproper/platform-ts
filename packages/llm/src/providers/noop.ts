import type { CompletionResponse, LLMProvider } from "../llm.js";

/** An {@link LLMProvider} that returns an empty-text completion for every request. */
export class NoopLLMProvider implements LLMProvider {
  complete(): Promise<CompletionResponse> {
    return Promise.resolve({ text: "", model: "noop" });
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }
}
