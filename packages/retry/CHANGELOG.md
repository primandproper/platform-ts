# @primandproper/retry

## 0.1.0

### Minor Changes

- a124406: Add a required `warn()` method to the `RetryLogger` interface. Breaking for injected loggers that lack `warn`. Adds `maxElapsedMs` config and `RunOptions`.
