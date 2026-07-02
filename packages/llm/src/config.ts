import { z } from "zod";

/** Anthropic-provider config. `apiKey` is required; `model` defaults to a current Claude. */
export const AnthropicLLMConfigSchema = z.object({
  apiKey: z.string(),
  model: z.string().default("claude-sonnet-4-6"),
  baseUrl: z.string().default("https://api.anthropic.com/v1/messages"),
  maxTokens: z.number().int().positive().default(1024),
});

export type AnthropicLLMConfig = z.infer<typeof AnthropicLLMConfigSchema>;

/** OpenAI-provider config. `apiKey` is required; `model` defaults to a current GPT. */
export const OpenAILLMConfigSchema = z.object({
  apiKey: z.string(),
  model: z.string().default("gpt-4o"),
  baseUrl: z.string().default("https://api.openai.com/v1/chat/completions"),
  maxTokens: z.number().int().positive().default(1024),
});

export type OpenAILLMConfig = z.infer<typeof OpenAILLMConfigSchema>;

/**
 * LLM config. Replaces the Go `env:`-tagged struct + ozzo `ValidateWithContext`. `echo`
 * (default) returns a deterministic response and never hits the network; `noop` returns an
 * empty completion; `anthropic` and `openai` call their respective REST APIs and therefore
 * require an `apiKey`. Keys are passed via config — the package never reads the environment
 * itself, keeping it server-side.
 */
export const LLMConfigSchema = z
  .object({
    provider: z.enum(["echo", "noop", "anthropic", "openai"]).default("echo"),
    anthropic: AnthropicLLMConfigSchema.optional(),
    openai: OpenAILLMConfigSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.provider === "anthropic" && cfg.anthropic === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["anthropic"],
        message:
          "anthropic config (with apiKey) is required when provider is 'anthropic'",
      });
    }
    if (cfg.provider === "openai" && cfg.openai === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["openai"],
        message: "openai config (with apiKey) is required when provider is 'openai'",
      });
    }
  });

export type LLMConfig = z.infer<typeof LLMConfigSchema>;
export type LLMConfigInput = z.input<typeof LLMConfigSchema>;
