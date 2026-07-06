---
"@primandproper/observability": minor
---

Remove the `name` field from the metrics and tracing config schemas and default both providers to OpenTelemetry (`otel`). Breaking for configs that set `name` or relied on the previous `noop` default. Logger/Operation gained additive optional members.
