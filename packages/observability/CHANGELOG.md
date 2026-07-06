# @primandproper/observability

## 0.1.0

### Minor Changes

- a124406: Remove the `name` field from the metrics and tracing config schemas and default both providers to OpenTelemetry (`otel`). Breaking for configs that set `name` or relied on the previous `noop` default. Logger/Operation gained additive optional members.

### Patch Changes

- Updated dependencies [a124406]
  - @primandproper/errors@0.0.2
