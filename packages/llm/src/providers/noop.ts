import type { CompletionChunk, CompletionResponse, LLMProvider } from "../llm.js";

/** An {@link LLMProvider} that returns an empty-text completion for every request. */
export class NoopLLMProvider implements LLMProvider {
  complete(): Promise<CompletionResponse> {
    return Promise.resolve({ text: "", model: "noop" });
  }

  /** Streams nothing but a terminal empty chunk, mirroring the empty {@link complete} result. */
  async *completeStream(): AsyncGenerator<CompletionChunk> {
    yield { delta: "", usage: { inputTokens: 0, outputTokens: 0 } };
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }
}
