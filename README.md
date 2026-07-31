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

| Package                        | Purpose                                                                   |
| ------------------------------ | ------------------------------------------------------------------------- |
| `@primandproper/observability` | `Logger` (pino on Node, console in browser) + OTel tracer/meter aliases   |
| `@primandproper/cache`         | `Cache<T>` (memory/redis on Node, memory/web-storage in browser)          |
| `@primandproper/cryptography`  | `Encryptor` + `Hasher` over WebCrypto                                     |
| `@primandproper/random`        | Cryptographically secure random (hex, base32, base64url) over WebCrypto   |
| `@primandproper/compression`   | `Compressor` interface with swappable providers                           |
| `@primandproper/cookies`       | `CookieStore` interface with swappable providers                          |
| `@primandproper/httpclient`    | Thin `fetch` wrapper with OpenTelemetry spans                             |
| `@primandproper/ratelimiting`  | `RateLimiter` interface with swappable providers                          |
| `@primandproper/eventstream`   | `EventStream` over SSE and WebSocket                                      |
| `@primandproper/analytics`     | `EventReporter` interface with swappable providers                        |
| `@primandproper/eventcapture`  | Non-blocking high-volume event capture draining to a swappable sink       |
| `@primandproper/authorization` | Synchronous permission checks everywhere, policy resolution on the server |

### Server-only

| Package                          | Purpose                                                          |
| -------------------------------- | ---------------------------------------------------------------- |
| `@primandproper/secrets`         | `SecretSource` interface with swappable providers                |
| `@primandproper/authentication`  | Password hashing, TOTP, and tokens                               |
| `@primandproper/email`           | `Email` sending interface with swappable providers               |
| `@primandproper/uploads`         | `UploadManager` object storage with swappable providers          |
| `@primandproper/messagequeue`    | `Publisher`/`Consumer` interfaces with swappable providers       |
| `@primandproper/notifications`   | `AsyncNotifier` publisher + mobile `PushNotificationSender`      |
| `@primandproper/distributedlock` | Acquire/release/refresh distributed locks                        |
| `@primandproper/featureflags`    | `FeatureFlagManager` with typed evaluation, OpenFeature-backed   |
| `@primandproper/search`          | Text + document index/search interfaces with swappable providers |
| `@primandproper/llm`             | LLM completions over Anthropic and OpenAI                        |
| `@primandproper/healthcheck`     | `Checker` + `Registry` aggregating component health              |
| `@primandproper/qrcodes`         | QR code generation, for TOTP setup flows                         |

## Parity with platform-go

`platform-go` is the source of truth. See [`PORT_PROGRESS.md`](./PORT_PROGRESS.md) for the
full package- and provider-level parity breakdown, scope decisions, and remaining work.

## Development

```bash
pnpm install
pnpm build && pnpm typecheck && pnpm test && pnpm lint
```

See `CLAUDE.md` for the package-modality rules and house style.
