---
"@primandproper/llm": minor
---

Add a required `completeStream()` method to the `LLMProvider` interface. Breaking for external `LLMProvider` implementers. Adds `timeoutMs`/`retry` config and request cancellation via `signal`.
