# platform-ts remediation plan

A full-repo audit against the repository's promise: **"import once, enjoy professional
outcomes"** — automatic observability, graceful error handling, sane performance, and
robustness from every package. Audited at commit `66a2561` (2026-07-04); file:line
references are anchored to that commit and will drift as fixes land.

## How to work this document

- Items have stable IDs (`OBS-1`, `CACHE-2`, …). Reference them when delegating: "fix MQ-1".
- Work the workstreams **in order** — Workstream 1 changes the economics of everything after it.
- Each item states the problem, the fix, and acceptance criteria. Check the box (`[x]`) when
  the fix is merged; add a `→ note` line if the fix deviated from what's written here.
- **Templates to copy, not invent:** `notifications` is the model citizen for instrumentation
  (`packages/notifications/src/support.ts` — `senderInstruments`; spans + `op.set`/`op.error` +
  sends/errors counters on every sender). `messagequeue`'s publish paths
  (`packages/messagequeue/src/providers/redis.node.ts:91-114`) and `database.query()`
  (`packages/database/src/database.ts:155-172`) are equally correct. `secrets` is the template
  for value hygiene. `uploads`' `FilesystemBucket.#pathFor` is the template for path containment.
- Severity: **H** = fix before relying on the package in anything real; **M** = violates the
  repo promise; **L** = polish / footgun.
- Before marking an H item done, add or extend a test that fails on the old behavior.

### Audit scoreboard (why Workstream 1 comes first)

24 packages construct an `Observer`; only 9 ever open a span (`database`, `httpclient`,
`messagequeue`, `notifications`, `search` (partially), `secrets`, `encoding`, `files`,
`uploads`); only 4 record any metric (`messagequeue`, `notifications`, `secrets`, `uploads`).
Everyone else reduces the observer to `.logger()` and emits keyless debug lines. That pattern
is downstream of three structural defects in the backbone — fix those first.

Packages with **zero findings**: `random`, `filtering`, `bitmask`, `fake`, `version`.

---

## Workstream 1 — observability backbone

Fix these before instrumenting anything downstream; they make the right thing the easy thing.

- [x] **OBS-1 (H, leverage)** `Observer.run` ignores metrics entirely.
  `packages/observability/src/observer.ts:44-51,69-80` — `Observer` bundles logger + tracer but
  discards `deps.metrics`; `run()` records no duration histogram and no error counter, which is
  why almost no package has metrics.
  **Fix:** thread `deps.metrics` into `NamedObserver`; have `run()` (and `begin()`/`end()`)
  auto-record an operation-duration histogram and outcome counter tagged by operation name.
  **Accept:** a package that only calls `observer.run` gets duration + error-count metrics with
  zero extra wiring; `RecordingObserver` asserts them in tests.
  → `NamedObserver` now mints `operation.duration` (ms histogram) + `operation.count` (counter)
  once in its constructor and `run()` records both tagged `{operation, outcome}` (`begin()`
  stays un-timed — caller owns that lifecycle). `RecordingObserver.runs` captures each settled
  run's outcome for assertions.

- [x] **OBS-2 (M)** Errors thrown out of `observer.run` are traced but never logged.
  `packages/observability/src/tracing.ts:66-74`, `observer.ts:69-80` — unless the consumer
  remembered `op.error`, the default failure path emits zero log lines (fully silent when no
  tracing SDK is registered, which is the default).
  **Fix:** log the error (with operation name) in `run`'s rejection path when it wasn't already
  recorded via `op.error`/`op.acknowledge` (track recording on the Operation to avoid doubles).
  **Accept:** an uncaught throw inside `run` produces exactly one error-level log and one span
  exception event.
  → `run` no longer delegates the error path to `withSpan`; it owns record+log, gated on
  `op.recorded()`. `withSpan` is unchanged (still standalone/exported). Collateral: httpclient's
  fetch provider caught-and-manually-logged inside `run` and rethrew — migrated it to
  `throw op.error(...)` so it doesn't double-log under the new contract.

- [x] **OBS-3 (M)** `throw op.error(err, …)` inside `run` double-records the exception.
  `packages/observability/src/operation.ts:107-127` + `tracing.ts:66-74` — exception event and
  ERROR status are applied twice per error span. Fix together with OBS-2 (same recorded-flag).
  → `Operation.recorded()` added (set by `error`/`acknowledge`); `run` skips its own
  record+log when the callback already recorded.

- [x] **OBS-4 (M)** `Logger` has no per-line values param, making context expensive.
  `packages/observability/src/logger.ts:10-22`; pino provider allocates a child logger per
  `.with()` (`providers/pino.node.ts:31-33`), and `Operation.set` does that **per attribute**.
  This is why keyless `"cache miss"`-style lines are the house style.
  **Fix:** extend the contract to `info(msg, values?)` (all levels); map to pino's
  `logger.info(values, msg)` mergingObject form; batch `Operation.setValues` into one `.with`.
  **Accept:** attaching a key to a log line is a single argument, no allocation chain.
  → Optional `values?` added to `debug/info/warn/error` on the contract, pino (mergingObject),
  and console providers. `Operation.setValues` already batched into one `.with`; left as-is.

- [x] **OBS-5 (M)** `provider: "pyroscope"` is an advertised silent noop.
  `packages/observability/src/providers/profiling.node.ts:31-46`, `config.ts:51` — unimplemented
  scaffold whose only warning goes through the possibly-noop logger. Either implement, or make
  construction throw/warn unconditionally (console fallback) and mark the enum value
  experimental in the schema description.
  → `PyroscopeProfiler` now `console.warn`s at construction (unconditional, not via the maybe-noop
  logger); `ProfilingConfigSchema` enum describes pyroscope as experimental/unimplemented.

- [x] **OBS-6 (L)** Dead config knobs: `provideMeterProvider`/`provideTracerProvider` parse and
  discard config; the `name` field and `otel` vs `noop` choice change nothing
  (`metrics.ts:75-81`, `tracing.ts:36-42`, `config.ts:24,38`). Wire them or delete them.
  → Both wired: `noop` → genuinely-inert provider; `otel` → injected ?? global-backed default.
  Dead `name` field removed from the metrics/tracing schemas. Default flipped `noop`→`otel` so
  the default still picks up a registered SDK (behavior-preserving vs the old global fallback).

- [x] **OBS-7 (L)** `noopTracerProvider`/`noopMeterProvider` are actually the OTel *global*
  providers (`observability.ts:22-28`) — rename (`defaultTracerProvider`) so the name stops lying.
  → Renamed to `defaultTracerProvider`/`defaultMeterProvider`; `noopTracerProvider`/
  `noopMeterProvider` now name genuinely-inert providers (non-recording span / `createNoopMeter`).

- [x] **ERR-1 (L)** `messageOf` on thrown plain objects yields `"[object Object]"`, poisoning
  every wrap prefix and span status (`packages/errors/src/message.ts:2-4`). Probe for a
  `message` property, fall back to JSON.
  → Probes a string `message` prop, else `JSON.stringify`, else `Object.prototype.toString`
  (the lint-clean `[object Object]` fallback for unserializable/circular values).

- [x] **ERR-2 (L)** `wrap()` of a `PlatformError` demotes it to plain `Error` and there is no
  cause-chain-walking `isPlatformError` (`packages/errors/src/wrap.ts:4-6`) — code that wraps at
  a boundary silently stops matching by code. Add a chain-walking check (or preserve the code).
  → Took the "preserve the code" branch: `wrap()` of a `PlatformError` returns a `PlatformError`
  with the same `code` (cause preserved). Kept `isPlatformError` a direct, honestly-narrowing
  predicate rather than chain-walking (which would lie about the return type).

---

## Workstream 2 — data-integrity correctness bugs

Each of these can lose data or violate the package's core guarantee. Test-first.

- [ ] **MQ-1 (H)** Kafka consumer commits past failed messages — silent message loss.
  `packages/messagequeue/src/providers/kafka.node.ts:171-197` — handler failure is swallowed
  (`op.acknowledge` + `onError`, no rethrow); kafkajs keeps delivering, and the next success
  commits `offset + 1`, committing past every earlier failed offset in the partition. The
  comment at line 171 promises redelivery the code doesn't deliver. **Verified against source.**
  **Fix:** rethrow the handler error from `eachMessage` (kafkajs will retry/seek), or manage
  offsets explicitly (pause + seek to failed offset). Decide and document the poison-message
  policy (bounded retries → dead-letter hook) while in there.
  **Accept:** integration-style test proving a failed message is redelivered and a later success
  does not commit past it.

- [ ] **LOCK-1 (H)** Lost leases are silent — `release`/`refresh` return `void`.
  `packages/distributedlock/src/distributedlock.ts:12-17`; all three providers detect
  "no longer owned" (Lua reply 0 at `providers/redis.node.ts:104-133`, `rowCount === 0` at
  `providers/postgres.node.ts:106-131`, token mismatch at `providers/memory.ts:78-95`) and
  respond with `logger.debug` only. A refresh loop keeps doing "exclusive" work after takeover.
  **Fix:** return `boolean` from `refresh`/`release` (or throw `LockLostError`); surface a
  fencing token on `Lock`.
  **Accept:** conformance test across all three providers: refresh after expiry+takeover reports
  loss.

- [ ] **CB-1 (H)** Half-open can wedge permanently.
  `packages/circuitbreaking/src/providers/partitioned.ts:44-58` — once `halfOpenMaxAttempts`
  probes are consumed, only a probe's `succeeded()`/`failed()` exits half-open; the cooldown
  re-entry check applies only to `open`. A hung probe blocks the partition forever. Config doc
  (`config.ts:11`) promises "forced back open" behavior that doesn't exist.
  **Fix:** re-open (or re-arm probes) after cooldown elapses in half-open too.

- [ ] **CB-2 (M)** `canProceed()` mutates state — a speculative check consumes a probe slot
  (`partitioned.ts:49-55`), compounding CB-1. Split predicate from acquisition (e.g.
  `tryAcquire()`), or document + rename.

- [ ] **CACHE-1 (H)** Corrupt entry turns `get()` into an uncaught throw forever.
  `packages/cache/src/providers/redis.node.ts:45`, `providers/web.browser.ts:50` — raw
  `JSON.parse`; the poisoned entry is never deleted. A cache must degrade to a miss.
  **Fix:** catch, log (with key), delete the entry, return `undefined`. Wrap `set` errors
  (circular data, Redis errors) with context while in there (`redis.node.ts:50`).

- [ ] **HTTP-1 (H)** Response body eagerly `JSON.parse`d regardless of content-type.
  `packages/httpclient/src/providers/fetch.ts:207-224` — a 200 with `text/plain`/HTML rejects
  the whole request; `text()` is unreachable. Parse lazily on `json()` (cache the result — the
  doc at `httpclient.ts:57-60` already claims caching; today it re-parses per call) and gate
  eager parsing on the response content-type.

- [ ] **COOK-1 (H)** Uncaught `URIError` on hostile cookie input.
  `packages/cookies/src/serialize.ts:94` — `decodeURIComponent` unguarded; `Cookie: a=%zz` makes
  `provideCookieStore` throw (`providers/header.ts:35`); in the browser any non-URI-encoded `%`
  written by another script breaks `get`/`getAll` (`providers/document.browser.ts:57-59`).
  **Fix:** try/catch per pair; skip (or pass through raw) the bad pair; never throw on parse.

- [ ] **COOK-2 (M)** Cookie attribute injection: `name`/`Domain`/`Path` interpolated raw into
  Set-Cookie (`serialize.ts:44,49-53`) — `"a; Domain=evil.com"` injects attributes. Validate
  against RFC 6265 token/value grammar (the npm `cookie` package's checks are the reference).
  Also reject `Max-Age=NaN` (line 47).

- [ ] **NUM-1 (M)** `round()` returns `NaN` for |x| ≥ 1e21 or < 1e-6, violating the module's
  own "nothing here silently returns NaN" header.
  `packages/numbers/src/numbers.ts:31` — `toString()` exponential notation breaks the
  string-splice trick; `roundToNearest` inherits (line 51). **Verified empirically.**
  Detect exponential notation and fall back to `Math.round(value * 10**d) / 10**d`, or throw.

- [ ] **ENC-1 (M)** XML codec fabricates objects from malformed input.
  `packages/encoding/src/providers/xml.ts:18,26` — `parse("this is not xml")` returns `{}`;
  mismatched tags parse "successfully". **Verified empirically.** Run
  `XMLValidator.validate` first and throw `EncodingError` on failure.

- [ ] **DB-1 (M)** Pool config parsed, documented, and ignored.
  `packages/database/src/config.ts:24-42` — `maxIdleConns`/`maxOpenConns`/`connMaxLifetimeMs`
  reach no pool. Either apply them (helper mapping to `pg`/`mysql2` pool options) or delete the
  fields. Config that lies is worse than config that doesn't exist.

- [ ] **DB-2 (M)** `mysqlDsn` emits Go's `user:pass@tcp(host:port)/db` — no JS driver parses it
  (`config.ts:63-66`). Emit a `mysql://` URI.

- [ ] **CRYPT-1 (M)** Salsa20 provider silently violates the `Encryptor` tamper-detection
  contract (`packages/cryptography/src/encryption.ts:9` vs `providers/salsa20.ts:59-67` — raw
  stream cipher, no MAC, returns garbage successfully). Encrypt-then-MAC it, or carve it out of
  the shared interface's promise explicitly. Related **CRYPT-2 (M):** its 8-byte random nonce
  (`salsa20.ts:15,51`) hits the birthday bound — XSalsa20 or a documented message budget.

- [ ] **FLAG-1 (H)** Feature-flag evaluation failures are invisible.
  `packages/featureflags/src/providers/openfeature.ts:59-92` — `get*Value` variants swallow
  provider errors by OpenFeature spec; a down LaunchDarkly means every flag silently returns its
  default org-wide with zero telemetry.
  **Fix:** use `get*Details` (exposes `errorCode`/`reason`), log + count non-`STATIC`/`DEFAULT`
  error reasons, and/or register an OpenFeature error hook.

- [ ] **AN-1 (H)** Multi-source analytics factory bare-catches construction failure into a
  silent `NoopReporter` (`packages/analytics/src/index.node.ts:59-63`, `index.browser.ts:59-63`)
  — a typo'd write key drops events forever with no log. Minimum: `logger.error` with source
  name + the Zod error; ideally a `degraded` counter/state the caller can inspect.

- [ ] **UP-1 (H)** S3/GCS writes buffer entire payloads in memory, defeating the package's own
  streaming contract (`stream.ts:7`). S3: `providers/s3.ts:44` (`Body: await toBytes(body)`) —
  use `@aws-sdk/lib-storage` `Upload` or accept the dependency call explicitly. GCS:
  `providers/gcp.ts:28` — `file.createWriteStream()` exists; use it.

- [ ] **UP-2 (M)** Filesystem writes are non-atomic with no partial-write cleanup
  (`providers/filesystem.ts:35-48`) — write to temp + rename (gocloud `fileblob` semantics);
  blob + `.attrs` sidecar are two unatomic writes. Also buffers whole body (fix with UP-1).

- [ ] **ES-1 (M)** WebSocket transport has no reconnection at all — any transient drop
  permanently ends the stream at debug level (`packages/eventstream/src/providers/websocket.ts:101-106`).
  Add auto-reconnect with backoff (use `@primandproper/retry`'s jitter), inspect `ev.code` to
  distinguish clean shutdown. Related **ES-2 (M):** SSE state machine ignores `readyState`
  (`providers/sse.ts:76-79`) — state lies in both directions (stays "open" through reconnects
  and after fatal errors; `onClose` never fires). `EventSourceLike` (`transports.ts:16-22`)
  needs `readyState` added. **ES-3 (M):** no heartbeat/liveness on either transport — half-open
  TCP delivers nothing forever while `state` reads `"open"`. **ES-4 (M):** one throwing
  subscriber breaks dispatch for all others (`providers/emitter.ts:86-128`) — try/catch per
  handler, log the throw.

- [ ] **RL-1 (H)** Memory rate limiter (the Node default provider) leaks one map entry per key
  forever (`packages/ratelimiting/src/providers/memory.ts:37,52-57`) — no sweep, no cap, no LRU.
  Per-IP/per-user keying = unbounded growth. Add a sweep or bounded LRU.
  Related **RL-2 (M):** negative `cost` mints capacity in both providers (`memory.ts:52-71`,
  `redis.node.ts:57-63` via `INCRBY`) — validate `cost >= 0` (integer).

- [ ] **SRCH-1 (M)** Search results silently truncate at backend defaults while the interface
  promises "unbounded when omitted" (`text.ts:18`): Typesense default 10
  (`providers/typesense.node.ts:130-135`), ES default 10 (`elasticsearch.node.ts:173-176`),
  Algolia default 20 first-page (`algolia.node.ts:95-98`); memory provider actually is
  unbounded. Pick a semantic (explicit default limit is fine) and enforce it uniformly.

---

## Workstream 3 — lifecycle & fail-fast

Everything holding a connection needs a close path; everything hitting the network needs a
deadline. Consider one shared decision here (e.g. add `close(): Promise<void>` to each
interface, and standard ioredis options) applied package-by-package.

- [ ] **LC-1 (H)** Private ioredis clients with no close path in three packages:
  `cache` (`providers/redis.node.ts:29`), `ratelimiting` (`providers/redis.node.ts:49`),
  `distributedlock` (`providers/redis.node.ts:65`). Connections pin the event loop; graceful
  shutdown impossible. **Fix:** add `close()` to each interface (mirror messagequeue's
  quit-then-disconnect), and accept an injected shared client for connection reuse.

- [ ] **LC-2 (M)** Default ioredis behavior makes a down Redis *hang* (~30s offline-queue/retry)
  instead of failing fast — worst for `cache` (a cache in front of a DB must degrade to a miss
  fast) and `distributedlock.acquire`. Set `maxRetriesPerRequest`/`enableOfflineQueue`
  deliberately and expose a timeout knob.

- [ ] **LC-3 (M)** messagequeue `stop()`/`close()` are sync fire-and-forget — buffered messages
  can drop on shutdown (`src/messagequeue.ts:28,44`; Pub/Sub flush ignored at
  `providers/pubsub.node.ts:87-90`; Kafka `producer.disconnect()` at `kafka.node.ts:90-96`;
  Redis `quit()` at `redis.node.ts:151-156`). Make them `Promise<void>` and await the flush.
  Related **LC-4 (M):** `ConsumerProvider` has no `close()` at all (`src/messagequeue.ts:67-73`)
  — SQS/PubSub/Kafka consumer-side clients leak.

- [ ] **LC-5 (M)** `featureflags` has no shutdown — `OpenFeature.close()` never called; buffered
  LaunchDarkly events lost on exit, pollers keep the process alive
  (`providers/launchdarkly.ts:41`, `posthog.ts:51`, manager at `featureflags.ts:34-75`).
  Related **LC-6 (M):** constant `CLIENT_DOMAIN`s mean a second construction silently rebinds
  the first manager's provider (`launchdarkly.ts:14`, `posthog.ts:13`) — derive domain per call.

- [ ] **LC-7 (M)** notifications: no APNs/FCM client shutdown (`apns.node.ts:54-56` — apn
  `Provider.shutdown()` exists; `fcm.node.ts:40-53` — apps never `deleteApp`'d);
  `PushNotificationSender` lacks the `close()` that `AsyncNotifier` got.

- [ ] **LC-8 (M)** messagequeue abort race: `signal` listener registered after `await`s — an
  abort during connect/subscribe is missed and `consume()` never resolves
  (`kafka.node.ts:202-208`, `redis.node.ts:198-207`). Re-check `signal.aborted` after awaits /
  register the listener first.

- [ ] **LC-9 (M)** Kafka consumer death is invisible — no `consumer.on('crash'/'disconnect')`;
  a non-retriable error stops flow while `consume()` stays pending and `onError` never fires
  (`kafka.node.ts:163-209`).

- [ ] **LC-10 (M)** SQS receive-error path hot-loops with no backoff
  (`providers/sqs.node.ts:194-201`) — bad queue URL/IAM error becomes a tight error loop. Add
  exponential backoff on consecutive receive failures.

- [ ] **LC-11 (M)** Redis consumer has zero backpressure — every message fires
  `void this.#deliver(...)` (`providers/redis.node.ts:188-190`); unbounded concurrency under
  flood. Serial delivery or a bounded queue.

- [ ] **LC-12 (M)** analytics `shutdown()`/`flush()` have no deadline
  (`src/vendor.ts:91-105`; posthog-node's `shutdown(timeoutMs)` unused at `posthog.node.ts:60`)
  — a wedged flush stalls process exit at exactly the moment flush-on-shutdown must be bounded.

- [ ] **LC-13 (M)** database: readiness failures swallow the driver error in a bare `catch {`
  and give up at `debug` level (`src/database.ts:133-137`); `close()` skips the write pool if
  the read pool's `end()` rejects (`database.ts:144-149`). Log the cause at error level;
  `allSettled` the drains.

- [ ] **HC-1 (M)** healthcheck has no aggregate deadline — a hanging checker built without
  `timeoutMs` hangs the whole report forever (`packages/healthcheck/src/index.ts:147-152`).
  Default per-check timeout or registry-level deadline.

---

## Workstream 4 — instrumentation sweep

Do after OBS-1..4 (the backbone makes most of this nearly free). The pattern to copy is
`notifications`: wrap operations in `observer.run`, `op.set` the identifying keys,
`op.error` on failure, counters via `makeMetrics` (until OBS-1 lands).

- [ ] **INST-1 (H)** httpclient: inject W3C trace context. `observer.run` starts an active span
  but `#buildInit` never calls `propagation.inject()` — no `traceparent` header, every
  distributed trace dies at the service boundary
  (`packages/httpclient/src/providers/fetch.ts:73-111,156-181`). Also add request
  counter/duration histogram by method+status (**INST-1b, M**).

- [ ] **INST-2 (H)** Dark packages — add spans + counters to the operations that are the
  package's reason to exist:
  - `cache` — get/set/delete spans; hit/miss/latency counters; log the **key** on misses
    (`providers/redis.node.ts:42`, `memory.ts:44,49`, `web.browser.ts:47`).
  - `distributedlock` — acquire/release/refresh spans; contention counter; key on every log
    (`memory.ts:58`, `redis.node.ts:85`, `postgres.node.ts:91`). Also honor injected
    `deps.observer` — the factory drops it (`src/index.ts:54-66`), and messagequeue ignores it
    everywhere too (all providers call `makeObserver` directly).
  - `ratelimiting` — allowed/denied counters; key on the denial log (`memory.ts:61`,
    `redis.node.ts:71`).
  - `circuitbreaking` — state-transition counter + state gauge; **recovery (close) currently
    logs at `debug`** — raise to `info`/`warn` (`partitioned.ts:84-102`); rejected-call counter
    in `canProceed`.
  - `email` — all five providers hold dead observers (`mailgun.ts:54-58`, `mailjet.ts:51-55`,
    `sendgrid.ts:45-49`, `resend.ts:57-61`, `postmark.node.ts:65-69`); wrap `send()` in
    `observer.run`, copy `senderInstruments`. Add vendor request-id + recipient-domain to error
    logs; postmark must pass the `cause` to the logger (`postmark.node.ts:76`).
  - `llm` — no span on `complete()`, and parsed token usage never becomes metrics — the single
    most valuable LLM metric (cost) is dropped (`anthropic.node.ts:69-70,123-128`,
    `openai.node.ts:64-65,117-122`). Span + input/output-token counters + capture the vendor
    `request-id` header on errors.
  - `analytics` — spans/counters for events sent/dropped; attach error listeners to the
    buffered vendor clients (posthog-node, @segment/analytics-node) so background delivery
    failures surface (`posthog.node.ts:28`, `segment.node.ts:32`, `vendor.ts:59-105`).
  - `authentication` — failed password/TOTP verifications currently produce **zero signal**
    (`providers/scrypt.ts:95-115`, `providers/totp.ts:109-128`); count + (debug-)log outcomes.
  - `compression` — spans with input/output sizes; wrap corrupt-input errors in a typed error
    like encoding's `EncodingError` (`providers/zlib.node.ts:71-74`, `web-standard.ts:40-43`).
  - `healthcheck` — span per check; **log unhealthy results at warn/error** — today a failing
    component is invisible in logs entirely (`src/index.ts:64-66,147-158`).
  - `search`/Typesense — the one dark sibling: no spans, error logs without error object or id
    (`providers/typesense.node.ts:104-170`); bring to ES/Algolia parity.

- [ ] **INST-3 (M)** notifications: platform-disabling init failures (bad .p8/service account)
  log at `debug` (`src/index.ts:105,114,119`) — raise to error + counter; iOS push silently
  stopping is invisible at production log levels.

- [ ] **INST-4 (M)** retry: the retry log omits the causing error, exhaustion is completely
  silent, and `RetryLogger` only has `debug` so nothing can ever surface higher
  (`packages/retry/src/retry.ts:4-6,39-56`). Include the error per attempt; warn-level line on
  exhaustion with attempt count.

- [ ] **INST-5 (M)** files: `Dir.sub()` silently drops observability — doc says "sharing this
  one's observability" but `sub()` re-opens without deps (`packages/files/src/files.ts:169-172`).

- [ ] **INST-6 (L)** Keyless/context-free logs elsewhere: featureflags static provider
  (`providers/static.ts:45` — no flag key); LD SDK logs bypass the injected logger
  (`launchdarkly.ts:36-40` — forward `deps.logger`).

- [ ] **INST-7 (L)** httpclient records `url.full` post-query-merge on spans/logs
  (`fetch.ts:76,95,99,102`) — query-string tokens land in telemetry; strip or redact query.
  Same class: notification titles on spans (`apns.node.ts:117`, `fcm.node.ts:72`) — PII;
  analytics puts `userId` in error logs (`vendor.ts:71`). Decide a telemetry-PII stance once.

---

## Workstream 5 — timeouts, retries, streaming

- [ ] **NET-1 (M)** No timeout on vendor calls: `llm` (`anthropic.node.ts:95`,
  `openai.node.ts:90` — the SDKs this package avoids ship a 10-min default; replace it),
  `email` (`resend.ts:64`, `sendgrid.ts:52`, `mailgun.ts:61`, `mailjet.ts:58`). Add
  `AbortSignal.timeout` with a config knob, default on.

- [ ] **NET-2 (M)** Nothing in the repo uses `@primandproper/retry`, and retry itself lacks the
  features integration needs: no `shouldRetry` predicate (4xx retried alongside 503), no
  `AbortSignal`/cancellation, no total-elapsed cap (`packages/retry/src/retry.ts:39-56`).
  **Fix retry first** (predicate + signal + deadline), then adopt in `llm` + `email` (vendors
  document 429/5xx as retryable) and make httpclient's policy idempotency- and abort-aware
  (`fetch.ts:85-92` — today caller aborts still sleep out full backoff, and POSTs retry on
  network errors with no opt-out).

- [ ] **STRM-1 (M)** compression is bytes-only — built *on* `CompressionStream` then collapses
  it (`compression.ts:6-11,30`, `providers/web-standard.ts:37`). Add a stream-in/stream-out
  surface next to the bytes one.

- [ ] **STRM-2 (M)** `decodeRequest` buffers unbounded attacker-typed bodies and picks the
  parser from the client's Content-Type, outside `instrument()`
  (`packages/encoding/src/encoding.ts:192-199`). Add a max-size option, an allowed-codecs
  option, and move the body read inside instrumentation.

- [ ] **STRM-3 (M)** llm has no streaming surface at all (`src/llm.ts:43-48`) — long
  generations buffer fully and are likeliest to hit intermediary timeouts. At minimum document
  the seam; ideally `completeStream()` (SSE parsing for both vendors).

- [ ] **PERF-1 (M)** `RedisCache` lacks `BatchCache` while the memory provider has it — tests
  batch, production does N round trips (`providers/redis.node.ts:21` vs `memory.ts:26`).
  Implement with `MGET` / pipeline of `SET EX`.

- [ ] **PERF-2 (M)** secrets: no caching — every `get` is a remote round trip; a Secret Manager
  blip is an outage (`gcp.node.ts:89-104`, `ssm.node.ts:106-122`, `kubectl.node.ts:112-130`).
  Short-TTL memoization + in-flight dedup (compose with `@primandproper/cache`). Kubectl
  additionally re-fetches and decodes the whole secret per key (`kubectl.node.ts:63-74`).

- [ ] **PERF-3 (L)** Lua scripts sent in full per call — use `defineCommand`/EVALSHA
  (ratelimiting `redis.node.ts:58`; distributedlock `redis.node.ts:108,120`).

- [ ] **PERF-4 (L)** Byte-at-a-time base64 building (`cryptography/src/base64.ts:8-14`,
  `random/src/encoding.ts:43-48`) — chunked conversion.

- [ ] **PERF-5 (L)** search has no bulk-index path (`document-index.ts:18-25`) — N docs = N
  sequential round trips despite `_bulk`/`saveObjects`/`import()` existing on all three
  backends. At least leave the seam.

---

## Workstream 6 — remaining medium/low backlog (by package)

Security-adjacent first.

- [ ] **SEC-1 (M)** `Dir` has no path containment — `resolve()` is bare `join`; `../` escapes
  silently and every method routes through it (`packages/files/src/files.ts:165-167`). Copy
  uploads' `FilesystemBucket.#pathFor`.
- [ ] **SEC-2 (M)** cookies: no `httpOnly` server default and no config field for it
  (`config.ts:7-11`); no signing/integrity option or warning anywhere (compose a signed
  provider with `@primandproper/cryptography`, or document loudly).
- [ ] **SEC-3 (L)** Pusher defaults to non-TLS (`notifications/src/config.ts:9`) — flip default.
- [ ] **SEC-4 (L)** scrypt `verify()` trusts embedded cost params — unbounded `N` from an
  untrusted hash allocates GBs (`providers/scrypt.ts:126-157,42`); add ceilings.
- [ ] **SEC-5 (L)** auth polish: TOTP error message leaks a secret char + `generate()` throws
  raw (`providers/totp.ts:47-71,105-107`); scrypt `cost` not schema-validated as power of two,
  `hash()` unwrapped (`config.ts:9`, `providers/scrypt.ts:81-93`); token generator accepts
  length 0 (`providers/tokens.ts:18-20`); no TOTP replay-prevention seam (docstring at minimum).
- [ ] **SEC-6 (L)** cryptography: bad base64 key throws bare `InvalidCharacterError` at
  construction, wrong-length key surfaces only on first use (`config.ts:8-25`, `aes-gcm.ts:57,
  99-102`, `salsa20.ts:40`) — validate decodability + length in the factory.

- [ ] **DL-1 (M)** distributedlock: memory provider's `refresh` revives expired leases —
  no expiry check, diverging from redis/postgres (`providers/memory.ts:87-94` vs `#owns` at
  72-75). Align semantics; extend the conformance suite to pin it.
- [ ] **DL-2 (L)** Expired residue never cleaned: memory `Map` entries and Postgres rows linger
  forever (`memory.ts:41`, `postgres.node.ts:60-68`).
- [ ] **MQ-2 (L)** Consumer cache keyed by topic ignores the handler — second
  `provideConsumer(topic, otherHandler)` silently returns the first consumer
  (`providers/support.ts:63-69`). Throw on mismatch or key by both.
- [ ] **MQ-3 (L)** Consumer metrics asymmetry: `_consumed` increments before the handler,
  no error counter — a 100%-failing consumer looks healthy in metrics (`support.ts:38-43`).
- [ ] **MQ-4 (L)** `parseAddress` breaks IPv6 (`redis.node.ts:49-55`).
- [ ] **DB-3 (L)** `DatabaseNotReadyError` exported + documented, never thrown
  (`database.ts:67-73`). DSN helpers mishandle special chars (`config.ts:50,59`). sqlite adapter
  routes `reader`-absent writes to `.all()` contradicting its own doc, and `prepare` throws sync
  from an async-typed method (`adapters.ts:53-57,82-86`).
- [ ] **CACHE-2 (M)** InMemoryCache unbounded, read-time-only eviction
  (`providers/memory.ts:27,41-53`) — cap + sweep (same class: uploads `MemoryBucket`, CB
  partitions map `partitioned.ts:120,130-137` — consider one shared bounded-map utility).
- [ ] **CACHE-3 (L)** Provider semantic drift: memory returns by reference (mutations poison the
  cache), Redis returns a JSON clone that mangles Dates/Maps — document, or structuredClone in
  memory. `WebStorageCache.set` doesn't handle `QuotaExceededError` (`web.browser.ts:61`) —
  a routine failure, not exceptional.
- [ ] **RL-3 (L)** Redis rate limiter: no TTL self-heal (a TTL-less counter denies forever —
  add `if pttl < 0 then PEXPIRE` to the script, `redis.node.ts:30-37,68`); raw ioredis errors
  unwrapped with no fail-open/closed policy (`redis.node.ts:58-64`); memory default on Node
  means multi-instance services silently get per-process limits (doc/warn, `config.ts:24`).
- [ ] **SRCH-2 (L)** ES: index-name case mismatch between exists/create/use
  (`elasticsearch.node.ts:121-123`); delete-of-missing trips the circuit breaker
  (`elasticsearch.node.ts:203-209` — treat 404 as no-op like the Typesense sibling).
- [ ] **HC-2 (L)** healthcheck: caller-initiated aborts read as `unhealthy` — distinguish
  AbortError (`src/index.ts:58-67`).
- [ ] **ES-5 (L)** eventstream: `noop` default transport connects to nothing silently
  (`config.ts:10` — warn on construction); SSE named-event listeners never removed
  (`sse.ts:80-84,87-97`); lifecycle events debug-only.
- [ ] **UP-3 (L)** uploads: `ErrCircuitBroken` is a shared singleton (stack points at module
  load — same for notifications' `ErrPlatformNotSupported`, `mobile.ts:59-61`; make factories);
  no max-size backstop; `NoopUploadManager.signedURL` returns `""` instead of rejecting
  (`providers/noop.ts:51-53`).
- [ ] **EM-1 (L)** email: Resend `ping()` uses undocumented `OPTIONS /emails` (not a real
  health check); unguarded `response.json()` on 2xx (`mailgun.ts:76`, `mailjet.ts:73`,
  `resend.ts:79`); duplicated divergent `FetchLike` exports (`resend.ts:17-56` vs
  `providers/http.ts:4-14`, both exported from `index.ts:17-18`).
- [ ] **LLM-1 (L)** `ping()` always succeeds — validate the key against a free authenticated
  endpoint (`GET /v1/models`) (`anthropic.node.ts:136-138`, `openai.node.ts:130-132`). Same
  pattern: secrets gcp/ssm/kubectl `ping()` unconditionally resolves
  (`gcp.node.ts:111-113`, `ssm.node.ts:129-131`, `kubectl.node.ts:136-138`).
- [ ] **AN-2 (L)** analytics: browser Segment `load()` failures unobserved
  (`segment.browser.ts:30-32`); unknown-source warn allocates + spams per call
  (`multisource.ts:91-94`); PostHog `DEFAULT_HOST` is the legacy endpoint — use
  `us.i.posthog.com` (`posthog.node.ts:10`, `posthog.browser.ts:10`).
- [ ] **FLAG-2 (L)** static provider `evaluate` casts unchecked (`static.ts:49`).
- [ ] **ID-1 (L)** ULID `isValid` accepts timestamp-overflow IDs (spec caps first char at `7`;
  `packages/identifiers/src/ulid.ts:7,30-32`).
- [ ] **QR-1 (L)** qrcodes: raw library errors unwrapped (`src/qrcodes.ts:57-67`).
- [ ] **COOK-3 (L)** cookies: no size guard — >4093 bytes silently dropped by browsers; warn.

---

## Definition of done for the repo

- Every provider that performs I/O wraps its operations in `observer.run` with identifying
  attributes, and gets duration/outcome metrics via the backbone (OBS-1).
- Every log line about a specific key/flag/lock/message names it.
- Every held connection has an awaitable `close()`; every network call has a deadline.
- Every "degrade" decision (noop fallback, default value, dropped event) emits at least a
  warn-level log the first time it happens.
- The conformance suites pin cross-provider semantics (lock refresh-after-expiry, cache
  miss-on-corrupt-entry, search limit behavior) so provider swaps stay honest.
