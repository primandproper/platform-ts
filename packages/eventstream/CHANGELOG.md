# @primandproper/eventstream

## 0.1.0

### Minor Changes

- a124406: Widen the injectable `EventSourceLike` interface with required `readyState` and `removeEventListener` members. Breaking for custom `EventSourceLike` implementations (standard EventSource implementations are unaffected). Adds heartbeat and reconnect options.

### Patch Changes

- Updated dependencies [a124406]
  - @primandproper/observability@0.1.0
