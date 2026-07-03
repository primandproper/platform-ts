# platform-ts

Isomorphic infrastructure abstractions for TypeScript — the sibling of `platform-go`.

Each package exposes a stable interface with swappable providers selected by config. Most
packages are **isomorphic**: the same import resolves to the right implementation whether
it runs on Node or in the browser, so call-site code (e.g. logging) is copy-paste portable
between backend and frontend.

## Packages

Every package is exactly one of three modalities (see `CLAUDE.md`): **universal** (pure
logic, one build), **isomorphic** (same import resolves per-environment), **server-only**
(Node bundle, may use Node built-ins).

### Universal

| Package                          | Purpose                                                                 |
| -------------------------------- | ----------------------------------------------------------------------- |
| `@primandproper/errors`          | Message extraction, prefixed wrapping, and a typed `PlatformError` base |
| `@primandproper/retry`           | Retry policies (exponential backoff + jitter)                           |
| `@primandproper/numbers`         | Number utilities (rounding, scaling, yield math)                        |
| `@primandproper/bitmask`         | Immutable bigint-backed bitmask over unsigned integers                  |
| `@primandproper/identifiers`     | Unique ID generation + validation (nanoid random, ulid sortable)        |
| `@primandproper/fake`            | Seeded test-data generation (thin `@faker-js/faker` wrapper)            |
| `@primandproper/encoding`        | `Encoder`/`ServerEncoderDecoder` over JSON, YAML, XML, TOML             |
| `@primandproper/circuitbreaking` | Circuit breakers (noop + partitioned)                                   |
| `@primandproper/version`         | Build-time version and VCS metadata                                     |

### Isomorphic

| Package                        | Purpose                                                                 |
| ------------------------------ | ----------------------------------------------------------------------- |
| `@primandproper/observability` | `Logger` (pino on Node, console in browser) + OTel tracer/meter aliases |
| `@primandproper/cache`         | `Cache<T>` (memory/redis on Node, memory/web-storage in browser)        |
| `@primandproper/cryptography`  | `Encryptor` + `Hasher` over WebCrypto                                   |
| `@primandproper/random`        | Cryptographically secure random (hex, base32, base64url) over WebCrypto |
| `@primandproper/compression`   | `Compressor` interface with swappable providers                         |
| `@primandproper/cookies`       | `CookieStore` interface with swappable providers                        |
| `@primandproper/httpclient`    | Thin `fetch` wrapper with OpenTelemetry spans                           |
| `@primandproper/ratelimiting`  | `RateLimiter` interface with swappable providers                        |
| `@primandproper/eventstream`   | `EventStream` over SSE and WebSocket                                    |
| `@primandproper/analytics`     | `EventReporter` interface with swappable providers                      |

### Server-only

| Package                          | Purpose                                                        |
| -------------------------------- | -------------------------------------------------------------- |
| `@primandproper/secrets`         | `SecretSource` interface with swappable providers              |
| `@primandproper/authentication`  | Password hashing, TOTP, and tokens                             |
| `@primandproper/email`           | `Email` sending interface with swappable providers             |
| `@primandproper/uploads`         | `BlobStore` blob uploads with swappable providers              |
| `@primandproper/messagequeue`    | `Publisher`/`Consumer` interfaces with swappable providers     |
| `@primandproper/notifications`   | `AsyncNotifier` publisher + mobile `PushNotificationSender`    |
| `@primandproper/distributedlock` | Acquire/release/refresh distributed locks                      |
| `@primandproper/featureflags`    | `FeatureFlagManager` with typed evaluation, OpenFeature-backed |
| `@primandproper/search`          | Text + vector index/search interfaces with swappable providers |
| `@primandproper/llm`             | LLM completions over Anthropic and OpenAI                      |
| `@primandproper/healthcheck`     | `Checker` + `Registry` aggregating component health            |
| `@primandproper/qrcodes`         | QR code generation, for TOTP setup flows                       |

## Parity with platform-go

`platform-go` is the source of truth. This table tracks every Go package against its
TypeScript status. Legend: ✅ ported · 🚧 in progress · 🔜 planned · ⬜ out of scope.

| platform-go          | TS                | Status | Notes                                                                                                             |
| -------------------- | ----------------- | :----: | ----------------------------------------------------------------------------------------------------------------- |
| `analytics`          | `analytics`       |   ✅   | interface + console/memory/noop; vendor providers (posthog/segment/rudderstack) pending                           |
| `artifacts`          | —                 |   ⬜   | empty package in Go; nothing to port                                                                              |
| `authentication`     | `authentication`  |   ✅   | scrypt (argon2 needs native dep, deliberately deferred), TOTP, tokens                                             |
| `bitmask`            | `bitmask`         |   ✅   |                                                                                                                   |
| `cache`              | `cache`           |   ✅   | memory, noop, redis, web-storage                                                                                  |
| `capitalism`         | —                 |   🔜   | payments (Stripe)                                                                                                 |
| `circuitbreaking`    | `circuitbreaking` |   ✅   | noop, partitioned                                                                                                 |
| `compression`        | `compression`     |   ✅   | noop, web-standard, zlib                                                                                          |
| `cookies`            | `cookies`         |   ✅   | document, header, noop                                                                                            |
| `cryptography`       | `cryptography`    |   ✅   | aes-gcm, subtle-hasher (fewer hash algos than Go; add as needed)                                                  |
| `database`           | `database`        |   ✅   | narrow port: instrumented client + pg/mysql/sqlite adapters + config; no executor/migrations                      |
| `database/filtering` | `filtering`       |   ✅   | standalone universal cursor pagination + filter DTO (URL-param (de)serialization)                                 |
| `distributedlock`    | `distributedlock` |   ✅   | memory, noop, redis, postgres (lease table over a `database` pool)                                                |
| `email`              | `email`           |   ✅   | resend, postmark, sendgrid, mailgun, mailjet; ses pending (needs AWS SDK)                                         |
| `embeddings`         | —                 |   🔜   | sibling to `llm` (ollama/openai/cohere)                                                                           |
| `encoding`           | `encoding`        |   ✅   | json, yaml, xml, toml                                                                                             |
| `errors`             | `errors`          |   ✅   | `PlatformError`, `wrap`, `messageOf`                                                                              |
| `eventstream`        | `eventstream`     |   ✅   | sse, websocket, emitter, noop                                                                                     |
| `fake`               | `fake`            |   ✅   |                                                                                                                   |
| `featureflags`       | `featureflags`    |   ✅   | OpenFeature + launchdarkly + posthog + static (exceeds Go)                                                        |
| `files`              | `files`           |   ✅   | line iteration, chunking, slicing, streaming, typed decode, `Dir` handle                                          |
| `healthcheck`        | `healthcheck`     |   ✅   |                                                                                                                   |
| `httpclient`         | `httpclient`      |   ✅   | fetch                                                                                                             |
| `identifiers`        | `identifiers`     |   ✅   | nanoid, ulid                                                                                                      |
| `llm`                | `llm`             |   ✅   | anthropic, openai, echo, noop                                                                                     |
| `messagequeue`       | `messagequeue`    |   ✅   | faithful Publisher/Consumer-provider port; redis(pub/sub)/sqs/pubsub/kafka/noop + memory                          |
| `notifications`      | `notifications`   |   ✅   | faithful server-only port; async: pusher/ably/noop · mobile: apns/fcm/noop; ws/sse framework-owned (out of scope) |
| `numbers`            | `numbers`         |   ✅   |                                                                                                                   |
| `observability`      | `observability`   |   ✅   | pino, console, profiling; deep tracing/metrics exporters pending                                                  |
| `panicking`          | —                 |   ⬜   | Go panic/recover idiom; no TS analogue                                                                            |
| `pointer`            | —                 |   ⬜   | Go pointer-helper idiom; no TS analogue                                                                           |
| `qrcodes`            | `qrcodes`         |   ✅   |                                                                                                                   |
| `random`             | `random`          |   ✅   | standard (WebCrypto), noop                                                                                        |
| `ratelimiting`       | `ratelimiting`    |   ✅   | memory, noop, redis                                                                                               |
| `reflection`         | —                 |   ⬜   | Go reflect/AST idiom; no TS analogue                                                                              |
| `retry`              | `retry`           |   ✅   |                                                                                                                   |
| `routing`            | —                 |   ⬜   | TS frameworks (Hono/Fastify/Express) own routing + middleware                                                     |
| `search`             | `search`          |   ✅   | typesense, memory-text, memory-vector, noop                                                                       |
| `secrets`            | `secrets`         |   ✅   | env, static, noop; gcp/aws-ssm/k8s pending                                                                        |
| `server`             | —                 |   ⬜   | TS frameworks own server bootstrap; gRPC rare in TS                                                               |
| `testutils`          | —                 |   🔜   | deferred — revisit when shared integration-test setup is needed                                                   |
| `uploads`            | `uploads`         |   ✅   | filesystem, memory, s3, noop; gcp/r2/backblaze + image processing pending                                         |
| `version`            | `version`         |   ✅   |                                                                                                                   |

**Scope decisions:** `database` is a narrow instrumented-pool port only — TS query builders
(Drizzle/Kysely/raw) own the connection seam, so there is no executor-inheritance or migration
layer. `routing`/`server` are out of scope because the TS ecosystem's frameworks already own them.
`panicking`/`pointer`/`reflection` wrap Go language features with no TypeScript equivalent. The
provider parity bar is: interface + noop + a local-first option where one exists + as many real
vendor providers as the JS ecosystem sensibly supports.

## Development

```bash
pnpm install
pnpm build && pnpm typecheck && pnpm test && pnpm lint
```

See `CLAUDE.md` for the package-modality rules and house style.
