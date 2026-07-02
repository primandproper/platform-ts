/** The role of a message in a chat completion. */
export type Role = "system" | "user" | "assistant";

/** A single chat message. */
export interface Message {
  role: Role;
  content: string;
}

/**
 * A chat-completion request. `messages` is the conversation; the optional fields tune the
 * call. `system` is a top-level instruction kept separate from `messages` so providers that
 * model it distinctly (Anthropic) and providers that fold it into the message list (OpenAI)
 * share one call-site shape.
 */
export interface CompletionRequest {
  messages: Message[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  system?: string;
}

/** Token usage reported by the provider, when available. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** A chat-completion response. */
export interface CompletionResponse {
  text: string;
  model: string;
  stopReason?: string;
  usage?: Usage;
}

/**
 * The chat-completion contract. Provider implementations live under `providers/` and are
 * selected by config — the same shape backs the deterministic `echo`/`noop` providers and
 * the REST providers (Anthropic, OpenAI).
 */
export interface LLMProvider {
  /** Generates a completion for the conversation. */
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  /** Verifies the backing provider is reachable. */
  ping(): Promise<void>;
}

/** Returns the content of the last `user` message, or `""` when there is none. */
export function lastUserMessage(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "user") {
      return message.content;
    }
  }
  return "";
}
