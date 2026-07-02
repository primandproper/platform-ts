import {
  lastUserMessage,
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

  ping(): Promise<void> {
    return Promise.resolve();
  }
}
