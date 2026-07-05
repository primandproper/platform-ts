import {
  lastUserMessage,
  type CompletionChunk,
  type CompletionRequest,
  type CompletionResponse,
  type LLMProvider,
} from "../llm.js";

/**
 * A deterministic {@link LLMProvider} for tests and local development. It echoes the last
 * user message back as `echo: <content>` and never touches the network.
 */
export class EchoLLMProvider implements LLMProvider {
  complete(request: CompletionRequest): Promise<CompletionResponse> {
    return Promise.resolve({
      text: `echo: ${lastUserMessage(request.messages)}`,
      model: "echo",
    });
  }

  /** Streams the same echo as a single delta, then a terminal usage chunk. */
  async *completeStream(request: CompletionRequest): AsyncGenerator<CompletionChunk> {
    yield { delta: `echo: ${lastUserMessage(request.messages)}` };
    yield { delta: "", stopReason: "stop", usage: { inputTokens: 0, outputTokens: 0 } };
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }
}
