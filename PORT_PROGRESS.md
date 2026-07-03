# Port Progress: platform-ts vs platform-go

Parity status of `@primandproper/platform-ts` against its source-of-truth sibling
[`platform-go`](../platform-go/). Snapshot: **2026-07-01**.

The bar for "100%" is **not** file-for-file translation. Scope was deliberately narrowed
(see [Scope & non-goals](#scope--non-goals)): match Go's _interface_ per package, and
right-size _providers_ to what the JS ecosystem sensibly supports — interface + noop +
a local-first option where one exists + as many real vendor providers as make sense.

## Headline

- **Interface parity: complete** for every in-scope package. All 34 TS packages build,
  typecheck, test, and lint green.
- **Package coverage: 34 / 36 in-scope Go packages ported.** Missing: `capitalism`,
  `embeddings` (both planned).
- **Provider coverage: the main remaining gap.** Many packages ship the interface +
  local/core providers but not yet the full vendor roster (cloud SDKs pending). Detail below.
- **6 Go packages are intentionally out of scope** (Go-idiom-only or owned by TS frameworks).

Legend: ✅ at parity · 🟡 interface done, providers incomplete · 🔜 planned, not started ·
⬜ out of scope · ➕ TS exceeds Go.

## Package-level parity

| platform-go          | platform-ts       | Status | Notes                                                                                                                                  |
| -------------------- | ----------------- | :----: | -------------------------------------------------------------------------------------------------------------------------------------- |
| `analytics`          | `analytics`       |   ✅   | isomorphic segment + posthog + multisource; console/memory/noop; rudderstack intentionally dropped                                     |
| `artifacts`          | —                 |   ⬜   | empty package in Go; nothing to port                                                                                                   |
| `authentication`     | `authentication`  |   ✅   | scrypt (vs Go argon2), TOTP, tokens                                                                                                    |
| `bitmask`            | `bitmask`         |   ✅   |                                                                                                                                        |
| `cache`              | `cache`           |   ➕   | memory/noop/redis + web-storage (browser)                                                                                              |
| `capitalism`         | —                 |   🔜   | payments (Stripe)                                                                                                                      |
| `circuitbreaking`    | `circuitbreaking` |   ✅   | noop, partitioned                                                                                                                      |
| `compression`        | `compression`     |   ✅   | noop, web-standard, zlib                                                                                                               |
| `cookies`            | `cookies`         |   ✅   | document, header, noop                                                                                                                 |
| `cryptography`       | `cryptography`    |   ✅   | enc: aes-gcm + salsa20 (noble) + passthrough; hashing: SHA-256/384/512; non-crypto checksums (adler32/crc64/fnv) intentionally dropped |
| `database`           | `database`        |   ✅   | narrow port (see scope): instrumented pool + pg/mysql/sqlite                                                                           |
| `database/filtering` | `filtering`       |   ➕   | standalone universal cursor pagination + filter DTO                                                                                    |
| `distributedlock`    | `distributedlock` |   ✅   | memory, noop, redis, postgres — full parity                                                                                            |
| `email`              | `email`           |   🟡   | resend/postmark/sendgrid/mailgun/mailjet; `ses` pending                                                                                |
| `embeddings`         | —                 |   🔜   | sibling to `llm` (ollama/openai/cohere)                                                                                                |
| `encoding`           | `encoding`        |   ✅   | json, yaml, xml, toml                                                                                                                  |
| `errors`             | `errors`          |   🟡   | `PlatformError`/`wrap`/`messageOf`; no grpc/http status mappers                                                                        |
| `eventstream`        | `eventstream`     |   ➕   | sse, websocket + emitter, noop                                                                                                         |
| `fake`               | `fake`            |   ✅   |                                                                                                                                        |
| `featureflags`       | `featureflags`    |   ➕   | OpenFeature + launchdarkly + posthog + static (exceeds Go)                                                                             |
| `files`              | `files`           |   ✅   | line iteration, chunking, slicing, streaming, typed decode                                                                             |
| `healthcheck`        | `healthcheck`     |   ✅   |                                                                                                                                        |
| `httpclient`         | `httpclient`      |   ✅   | fetch                                                                                                                                  |
| `identifiers`        | `identifiers`     |   ✅   | nanoid, ulid                                                                                                                           |
| `llm`                | `llm`             |   ➕   | anthropic, openai + echo, noop                                                                                                         |
| `messagequeue`       | `messagequeue`    |   ✅   | faithful Publisher/Consumer-provider port; redis(pub/sub)/sqs/pubsub/kafka/noop + memory                                               |
| `notifications`      | `notifications`   |   ✅   | faithful server-only port; async: pusher/ably/noop · mobile: apns/fcm/noop; ws/sse framework-owned (out of scope)                      |
| `numbers`            | `numbers`         |   ✅   |                                                                                                                                        |
| `observability`      | `observability`   |   🟡   | pino/console/profiling; deep OTel tracing/metrics exporters pending                                                                    |
| `panicking`          | —                 |   ⬜   | Go panic/recover idiom; no TS analogue                                                                                                 |
| `pointer`            | —                 |   ⬜   | Go pointer-helper idiom; no TS analogue                                                                                                |
| `qrcodes`            | `qrcodes`         |   ✅   |                                                                                                                                        |
| `random`             | `random`          |   ✅   | standard (WebCrypto), noop                                                                                                             |
| `ratelimiting`       | `ratelimiting`    |   ➕   | memory, noop, redis (Go has noop/redis only)                                                                                           |
| `reflection`         | —                 |   ⬜   | Go reflect/AST idiom; no TS analogue                                                                                                   |
| `retry`              | `retry`           |   ✅   |                                                                                                                                        |
| `routing`            | —                 |   ⬜   | TS frameworks (Hono/Fastify/Express) own routing                                                                                       |
| `search`             | `search`          |   🟡   | text nearly full + typesense; vector missing pgvector/qdrant                                                                           |
| `secrets`            | `secrets`         |   🟡   | env/static/noop; gcp/aws-ssm/k8s pending                                                                                               |
| `server`             | —                 |   ⬜   | TS frameworks own server bootstrap; gRPC rare in TS                                                                                    |
| `testutils`          | —                 |   🔜   | deferred — revisit when shared integration-test setup is needed                                                                        |
| `uploads`            | `uploads`         |   🟡   | filesystem/memory/s3/noop; gcp/r2/backblaze + image processing pending                                                                 |
| `version`            | `version`         |   ✅   |                                                                                                                                        |

## Provider-level parity

Only packages with meaningful provider gaps or additions are listed. Everything else is at
interface + provider parity.

| Package         | platform-go providers                                                                  | platform-ts providers                                               | Gap / delta                                                                                                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `analytics`     | segment, rudderstack, posthog, multisource, noop                                       | + console, memory (segment/posthog isomorphic)                      | rudderstack dropped (no browser SDK); per-call circuit breaker not ported (best-effort suffices)                                                                                                                                |
| `cryptography`  | enc: aes, salsa20 · hash: adler32/crc64/fnv/sha256/sha512                              | aes-gcm, salsa20, passthrough, subtle-hasher (SHA-256/384/512)      | salsa20 via `@noble/ciphers` (byte-parity verified vs Go); SHA-2 via WebCrypto; non-crypto checksums (adler32/crc64/fnv) intentionally dropped — no maintained isomorphic libs (crc64 has none) and hand-rolled crypto declined |
| `email`         | resend, postmark, sendgrid, mailgun, mailjet, ses, noop                                | + http, memory (same vendors)                                       | **missing** ses (needs AWS SDK)                                                                                                                                                                                                 |
| `errors`        | core + grpc, http (status-code mappers)                                                | core only                                                           | **missing** grpc/http error mappers (grpc likely n/a)                                                                                                                                                                           |
| `messagequeue`  | kafka, pubsub, redis, sqs, noop                                                        | kafka, pubsub, redis(pub/sub), sqs, noop, + memory                  | at parity; redis now PUB/SUB (was Streams); memory added                                                                                                                                                                        |
| `notifications` | async: ably/pusher/sse/websocket · mobile: apns/fcm                                    | async: pusher, ably, noop · mobile: apns, fcm, noop                 | at parity for framework-agnostic providers; ws/sse deferred (server-side connection mgmt + HTTP upgrade is framework-owned, like routing/server)                                                                                |
| `observability` | logging: slog/zap/zerolog/otelgrpc · tracing: oteltrace/cloudtrace · metrics: otelgrpc | pino, console, profiling                                            | **missing** deep OTel tracing + metrics exporters                                                                                                                                                                               |
| `search`        | text: algolia/elasticsearch/indexing · vector: pgvector/qdrant                         | algolia, elasticsearch, typesense, memory-text, memory-vector, noop | text at parity (+typesense); **vector missing** pgvector, qdrant                                                                                                                                                                |
| `secrets`       | env, gcp, kubectl, ssm, noop                                                           | env, static, noop                                                   | **missing** gcp, kubectl (k8s), ssm                                                                                                                                                                                             |
| `uploads`       | filesystem, s3, gcp, r2, backblaze, images, noop                                       | filesystem, memory, s3, noop                                        | **missing** gcp, r2, backblaze, image processing                                                                                                                                                                                |

## Remaining work toward 100%

**Phase — new packages (🔜):**

- `capitalism` — Stripe payments.
- `embeddings` — sibling to `llm` (ollama / openai / cohere).

**Phase — provider breadth (🟡 → ✅):**

- `email`: ses.
- `secrets`: gcp, aws-ssm, k8s.
- `uploads`: gcp, r2, backblaze + image processing.
- `search`: pgvector, qdrant (vector).
- `observability`: deep OTel tracing + metrics exporters.

**Deferred:**

- `testutils` (testcontainers) — revisit when shared integration-test setup is actually needed.
- Per-package READMEs for the packages that still lack them.

## Scope & non-goals

Intentionally **not** ported — these are not gaps:

- **`routing`, `server`** — the TS ecosystem's frameworks (Hono/Fastify/Express) already own
  routing, middleware, and OTel wiring. Porting them reinvents batteries-included frameworks.
- **`panicking`, `pointer`, `reflection`** — wrap Go language idioms with no TS equivalent.
- **`artifacts`** — empty package in Go; nothing to port.
- **`database` is a narrow port by design** — TS apps build on Drizzle/Kysely/raw `pg`
  (not Prisma), so the query builder owns the connection seam. Only instrumented pg/mysql/sqlite
  pool providers + config are ported; **no** query-executor inheritance, **no** migrations.

**Why:** Pike's rule — n is small. Full framework/DB-layer parity is a cathedral for a personal
library, and the TS ecosystem already supplies the framework/ORM layer Go's platform builds itself.

## Where TS exceeds Go (➕)

- `featureflags` — OpenFeature engine + launchdarkly/posthog/static providers.
- `cache` — adds a browser web-storage provider (isomorphic).
- `filtering` — extracted as a standalone universal package (Go nests it under `database`).
- `eventstream`, `llm`, `ratelimiting` — extra local/test providers (emitter, echo, memory).
