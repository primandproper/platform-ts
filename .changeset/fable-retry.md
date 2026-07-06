---
"@primandproper/retry": minor
---

Add a required `warn()` method to the `RetryLogger` interface. Breaking for injected loggers that lack `warn`. Adds `maxElapsedMs` config and `RunOptions`.
