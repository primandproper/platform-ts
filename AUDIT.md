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

- [x] **OBS-7 (L)** `noopTracerProvider`/`noopMeterProvider` are actually the OTel _global_
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

- [x] **MQ-1 (H)** Kafka consumer commits past failed messages — silent message loss.
      `packages/messagequeue/src/providers/kafka.node.ts:171-197` — handler failure is swallowed
      (`op.acknowledge` + `onError`, no rethrow); kafkajs keeps delivering, and the next success
      commits `offset + 1`, committing past every earlier failed offset in the partition. The
      comment at line 171 promises redelivery the code doesn't deliver. **Verified against source.**
      **Fix:** rethrow the handler error from `eachMessage` (kafkajs will retry/seek), or manage
      offsets explicitly (pause + seek to failed offset). Decide and document the poison-message
      policy (bounded retries → dead-letter hook) while in there.
      **Accept:** integration-style test proving a failed message is redelivered and a later success
      does not commit past it.
      → Both the handler and commit catch blocks now `throw op.error(...)` after `onError` instead of
      swallowing, so eachMessage rejects and kafkajs leaves the offset uncommitted for redelivery.
      Redelivery is unbounded (kafkajs retry); dead-letter left as a documented seam. New
      `kafka.node.test.ts` mocks kafkajs and proves a failed offset rejects+doesn't commit, and a
      later success commits `offset+1`, never past.

- [x] **LOCK-1 (H)** Lost leases are silent — `release`/`refresh` return `void`.
      `packages/distributedlock/src/distributedlock.ts:12-17`; all three providers detect
      "no longer owned" (Lua reply 0 at `providers/redis.node.ts:104-133`, `rowCount === 0` at
      `providers/postgres.node.ts:106-131`, token mismatch at `providers/memory.ts:78-95`) and
      respond with `logger.debug` only. A refresh loop keeps doing "exclusive" work after takeover.
      **Fix:** return `boolean` from `refresh`/`release` (or throw `LockLostError`); surface a
      fencing token on `Lock`.
      **Accept:** conformance test across all three providers: refresh after expiry+takeover reports
      loss.
      → `release`/`refresh` now return `Promise<boolean>` (`true` = owned+applied, `false` = lease
      lost) across all four providers; loss-log lines now carry the `key`. **Deliberately skipped the
      fencing token:** redis/postgres tokens are random UUIDs, not monotonic, so exposing one as a
      "fencing token" would lie — a real fence needs server-side `INCR`/sequence, out of scope here.
      Conformance suite now asserts `true` on owned release/refresh; memory tests assert `false` on
      release/refresh after expiry+takeover. Folded in **DL-1** below.

- [x] **CB-1 (H)** Half-open can wedge permanently.
      `packages/circuitbreaking/src/providers/partitioned.ts:44-58` — once `halfOpenMaxAttempts`
      probes are consumed, only a probe's `succeeded()`/`failed()` exits half-open; the cooldown
      re-entry check applies only to `open`. A hung probe blocks the partition forever. Config doc
      (`config.ts:11`) promises "forced back open" behavior that doesn't exist.
      **Fix:** re-open (or re-arm probes) after cooldown elapses in half-open too.
      → Added `#halfOpenAt` (stamped on entering half-open) and a `#halfOpenStalled()` check in
      `canProceed`: if all probes are spent and a full `openDurationMs` passed with no probe result,
      force back open and restart cooldown (the config's "forced back open" language). New test proves
      a never-resolved probe no longer wedges the partition.

- [x] **CB-2 (M)** `canProceed()` mutates state — a speculative check consumes a probe slot
      (`partitioned.ts:49-55`), compounding CB-1. Split predicate from acquisition (e.g.
      `tryAcquire()`), or document + rename.
      → Took the document route (rename would break the Go-parity `CircuitBreaker` interface): the
      interface doc and the impl now state plainly that `canProceed()` is an acquisition that consumes
      a half-open probe slot and must be called exactly once per guarded attempt.

- [x] **CACHE-1 (H)** Corrupt entry turns `get()` into an uncaught throw forever.
      `packages/cache/src/providers/redis.node.ts:45`, `providers/web.browser.ts:50` — raw
      `JSON.parse`; the poisoned entry is never deleted. A cache must degrade to a miss.
      **Fix:** catch, log (with key), delete the entry, return `undefined`. Wrap `set` errors
      (circular data, Redis errors) with context while in there (`redis.node.ts:50`).
      → Both providers now try/catch `JSON.parse`, `logger.error` with the key, drop the entry, and
      return a miss (a failing delete degrades to a miss too, not a re-throw). Redis `set` wraps both
      encode failures (`cache: failed to encode value for <key>`) and Redis errors with context; added
      `@primandproper/errors` as a dep. New tests: web (injected fake `Storage`) and redis (mocked
      ioredis) prove corrupt→miss+delete, plus a set-encode wrap assertion.

- [x] **HTTP-1 (H)** Response body eagerly `JSON.parse`d regardless of content-type.
      `packages/httpclient/src/providers/fetch.ts:207-224` — a 200 with `text/plain`/HTML rejects
      the whole request; `text()` is unreachable. Parse lazily on `json()` (cache the result — the
      doc at `httpclient.ts:57-60` already claims caching; today it re-parses per call) and gate
      eager parsing on the response content-type.
      → `wrapResponse` now gates eager `data` decoding on `isJsonContentType(...)` (`application/json`
      or a `+json` suffix); non-JSON 2xx keeps its raw text as `data` instead of throwing. `json()`
      memoizes its successful parse (a thrown parse isn't cached, so it re-throws honestly). Empty body
      stays `undefined`. New tests: text/plain body → raw data, and `json()` returns the same cached
      object across calls.

- [x] **COOK-1 (H)** Uncaught `URIError` on hostile cookie input.
      `packages/cookies/src/serialize.ts:94` — `decodeURIComponent` unguarded; `Cookie: a=%zz` makes
      `provideCookieStore` throw (`providers/header.ts:35`); in the browser any non-URI-encoded `%`
      written by another script breaks `get`/`getAll` (`providers/document.browser.ts:57-59`).
      **Fix:** try/catch per pair; skip (or pass through raw) the bad pair; never throw on parse.
      → `parseCookieHeader` now try/catches `decodeURIComponent` per pair and passes the raw
      (undecoded) value through on failure rather than dropping it; later pairs still parse. Both
      providers route through this, so header + document paths are covered. Test asserts `a=%zz`
      doesn't throw and preserves `%zz`.

- [x] **COOK-2 (M)** Cookie attribute injection: `name`/`Domain`/`Path` interpolated raw into
      Set-Cookie (`serialize.ts:44,49-53`) — `"a; Domain=evil.com"` injects attributes. Validate
      against RFC 6265 token/value grammar (the npm `cookie` package's checks are the reference).
      Also reject `Max-Age=NaN` (line 47).
      → `serializeCookie` now validates `name` (RFC 6265 token), `Domain` (hostname grammar), and
      `Path` (no CTL/`;`/`<`) against the reference `cookie`-package regexes and throws `TypeError` on
      violation; `Max-Age` rejects non-finite values before truncation. Tests cover each injection
      vector plus `NaN`.

- [x] **NUM-1 (M)** `round()` returns `NaN` for |x| ≥ 1e21 or < 1e-6, violating the module's
      own "nothing here silently returns NaN" header.
      `packages/numbers/src/numbers.ts:31` — `toString()` exponential notation breaks the
      string-splice trick; `roundToNearest` inherits (line 51). **Verified empirically.**
      Detect exponential notation and fall back to `Math.round(value * 10**d) / 10**d`, or throw.
      → Extracted a `shiftPow10(n, exp)` helper used by both scale steps: it keeps the exact
      decimal-string `e`-shift for normal magnitudes but falls back to plain `n * 10 ** exp` when
      `n.toString()` is already exponential (|n| ≥ 1e21 or < 1e-6). `roundToNearest` inherits the fix.
      Test pins several exponential-magnitude inputs to real values, none `NaN`.

- [x] **ENC-1 (M)** XML codec fabricates objects from malformed input.
      `packages/encoding/src/providers/xml.ts:18,26` — `parse("this is not xml")` returns `{}`;
      mismatched tags parse "successfully". **Verified empirically.** Run
      `XMLValidator.validate` first and throw `EncodingError` on failure.
      → `decode` now runs `XMLValidator.validate` and throws on failure (non-XML and mismatched tags);
      the manager's `instrument` wraps it into `EncodingError` (same pattern as JsonCodec leaning on
      `JSON.parse` throwing). Tests cover non-XML, mismatched tags, and the `EncodingError` surface.

- [x] **DB-1 (M)** Pool config parsed, documented, and ignored.
      `packages/database/src/config.ts:24-42` — `maxIdleConns`/`maxOpenConns`/`connMaxLifetimeMs`
      reach no pool. Either apply them (helper mapping to `pg`/`mysql2` pool options) or delete the
      fields. Config that lies is worse than config that doesn't exist.
      → Took the mapping route (deleting would break platform-go parity). Added `pgPoolSettings(cfg)`
      (`maxOpenConns`→`max`, `connMaxLifetimeMs`→`maxLifetimeSeconds`) and `mysqlPoolSettings(cfg)`
      (`maxOpenConns`→`connectionLimit`, `maxIdleConns`→`maxIdle`), each documenting the fields the
      driver has no equivalent for (pg idle cap, mysql2 lifetime) rather than silently pretending.
      Callers spread them into pool construction. Test pins both mappings.

- [x] **DB-2 (M)** `mysqlDsn` emits Go's `user:pass@tcp(host:port)/db` — no JS driver parses it
      (`config.ts:63-66`). Emit a `mysql://` URI.
      → Now emits `mysql://user:pass@host:port/db` with percent-encoded credentials (the form `mysql2`
      parses). Tests updated for the URI form incl. an `@:/`-laden password.

- [x] **CRYPT-1 (M)** Salsa20 provider silently violates the `Encryptor` tamper-detection
      contract (`packages/cryptography/src/encryption.ts:9` vs `providers/salsa20.ts:59-67` — raw
      stream cipher, no MAC, returns garbage successfully). Encrypt-then-MAC it, or carve it out of
      the shared interface's promise explicitly. Related **CRYPT-2 (M):** its 8-byte random nonce
      (`salsa20.ts:15,51`) hits the birthday bound — XSalsa20 or a documented message budget.
      → Took the explicit carve-out (encrypt-then-MAC would break the Go-interop raw-salsa20 format
      the tests and docstring depend on). Added `readonly authenticated: boolean` to `Encryptor`;
      `decrypt`'s tamper-rejection promise is now conditioned on it. AES-GCM `= true`; Salsa20 /
      passthrough `= false`. CRYPT-2: documented the message budget on Salsa20 (random 64-bit nonce →
      rotate well before ~2^24 messages; XSalsa20/AES-GCM for a bigger budget) rather than changing
      the wire format. Tests assert the `authenticated` flags and that tampered Salsa20 ciphertext
      decrypts (the documented carve-out, pinned).

- [x] **FLAG-1 (H)** Feature-flag evaluation failures are invisible.
      `packages/featureflags/src/providers/openfeature.ts:59-92` — `get*Value` variants swallow
      provider errors by OpenFeature spec; a down LaunchDarkly means every flag silently returns its
      default org-wide with zero telemetry.
      **Fix:** use `get*Details` (exposes `errorCode`/`reason`), log + count non-`STATIC`/`DEFAULT`
      error reasons, and/or register an OpenFeature error hook.
      → `evaluate` now routes through the `get*Details` variants; when `errorCode` is present it
      `warn`s (key + errorCode + errorMessage + reason) and increments a
      `featureflags.evaluation.errors` counter (tagged `error_code`), then returns the default. New
      tests use a fake erroring client to assert the log+count fire once and stay silent on clean
      evals; existing fake updated to the `*Details` methods.

- [x] **AN-1 (H)** Multi-source analytics factory bare-catches construction failure into a
      silent `NoopReporter` (`packages/analytics/src/index.node.ts:59-63`, `index.browser.ts:59-63`)
      — a typo'd write key drops events forever with no log. Minimum: `logger.error` with source
      name + the Zod error; ideally a `degraded` counter/state the caller can inspect.
      → Both factories now `logger.error(..., err, { source })` and increment an
      `analytics.source.degraded` counter (tagged `source`) in the catch before falling back to noop.
      New `index.node.test.ts` asserts a bad source logs+counts once and a fully-valid set stays
      quiet. (Left the inspectable `degraded` state as a counter rather than a new reporter API —
      the counter satisfies the "caller can alert on it" need without widening the surface.)

- [x] **UP-1 (H)** S3/GCS writes buffer entire payloads in memory, defeating the package's own
      streaming contract (`stream.ts:7`). S3: `providers/s3.ts:44` (`Body: await toBytes(body)`) —
      use `@aws-sdk/lib-storage` `Upload` or accept the dependency call explicitly. GCS:
      `providers/gcp.ts:28` — `file.createWriteStream()` exists; use it.
      → GCS: `write` now pipes the body into `file.createWriteStream()` (resumable upload) via
      `stream/promises` `pipeline` — no buffering. S3: a bytes body (already in memory) still takes a
      single `PutObject`; a **stream** body of unknown length now goes through `@aws-sdk/lib-storage`'s
      `Upload` (new dep) as a `Readable`, so it multiparts instead of draining into memory. Split by
      body type keeps the byte path testable against the fake `send` client (lib-storage bypasses
      `send` + needs a real endpoint provider). New `s3-stream.test.ts` mocks `Upload` to prove a
      stream routes through it as a `Readable`; GCS/fs stream writes are covered by the conformance
      suite.

- [x] **UP-2 (M)** Filesystem writes are non-atomic with no partial-write cleanup
      (`providers/filesystem.ts:35-48`) — write to temp + rename (gocloud `fileblob` semantics);
      blob + `.attrs` sidecar are two unatomic writes. Also buffers whole body (fix with UP-1).
      → `write` streams the body into a `<path>.<uuid>.tmp` sibling then `rename`s it into place
      (atomic on the same fs); a failure `rm`s the temp file and rethrows. Body is streamed via
      `pipeline`, no longer buffered. The blob is now crash-safe; the blob→`.attrs` pair is still two
      files (unavoidable without a journal — blob is written first so a reader never sees attrs without
      a blob). Test asserts no `.tmp` residue after a write.

- [x] **ES-1 (M)** WebSocket transport has no reconnection at all — any transient drop
      permanently ends the stream at debug level (`packages/eventstream/src/providers/websocket.ts:101-106`).
      Add auto-reconnect with backoff (use `@primandproper/retry`'s jitter), inspect `ev.code` to
      distinguish clean shutdown. Related **ES-2 (M):** SSE state machine ignores `readyState`
      (`providers/sse.ts:76-79`) — state lies in both directions (stays "open" through reconnects
      and after fatal errors; `onClose` never fires). `EventSourceLike` (`transports.ts:16-22`)
      needs `readyState` added. **ES-3 (M):** no heartbeat/liveness on either transport — half-open
      TCP delivers nothing forever while `state` reads `"open"`. **ES-4 (M):** one throwing
      subscriber breaks dispatch for all others (`providers/emitter.ts:86-128`) — try/catch per
      handler, log the throw.
      → **ES-1:** `onclose` now distinguishes clean codes (1000/1001/none) from transient drops; a
      drop reflects `connecting` and schedules an exponential-backoff-with-jitter reconnect (`reconnect`
      option, default on; `false` disables). A fresh open resets the backoff; a user `close()` cancels a
      pending reconnect. Rolled the backoff locally mirroring retry's formula — retry only exports a
      `run()`-oriented Policy, not a standalone jitter (noted for NET-2). **ES-2:** added `readyState`
      to `EventSourceLike`; SSE `onerror` now closes on CLOSED and reflects `connecting` on CONNECTING
      via a new `dispatchReconnecting()`. **ES-3:** base emitter gained an opt-in heartbeat
      (`heartbeatTimeoutMs`) armed on open / reset per message; on expiry WS tears down + reconnects,
      SSE reopens a fresh `EventSource`. **ES-4:** all handler fan-out goes through a `#safe()` wrapper;
      a throwing subscriber is isolated and logged via a `reportSubscriberError` hook the transports
      override. 9 new tests (fake timers for reconnect/heartbeat) cover all four.

- [x] **RL-1 (H)** Memory rate limiter (the Node default provider) leaks one map entry per key
      forever (`packages/ratelimiting/src/providers/memory.ts:37,52-57`) — no sweep, no cap, no LRU.
      Per-IP/per-user keying = unbounded growth. Add a sweep or bounded LRU.
      Related **RL-2 (M):** negative `cost` mints capacity in both providers (`memory.ts:52-71`,
      `redis.node.ts:57-63` via `INCRBY`) — validate `cost >= 0` (integer).
      → **RL-1:** added a `maxKeys` cap (default 100k). When a new key would exceed it, `#evict()`
      sweeps expired windows first (the leaked ones) and, if still over, evicts oldest-inserted
      entries — amortized O(n), only at the cap. **RL-2:** shared `assertValidCost()` in the interface
      module rejects non-integer/negative cost; called by both memory and redis `limit()`. Tests cover
      eviction (oldest key comes back fresh) and negative/fractional cost rejection.

- [x] **SRCH-1 (M)** Search results silently truncate at backend defaults while the interface
      promises "unbounded when omitted" (`text.ts:18`): Typesense default 10
      (`providers/typesense.node.ts:130-135`), ES default 10 (`elasticsearch.node.ts:173-176`),
      Algolia default 20 first-page (`algolia.node.ts:95-98`); memory provider actually is
      unbounded. Pick a semantic (explicit default limit is fine) and enforce it uniformly.
      → Adopted an explicit uniform semantic: `DEFAULT_SEARCH_LIMIT = 10` (in `document-index.ts`).
      `TextSearchOptions.limit` now documents "defaults to DEFAULT_SEARCH_LIMIT"; memory-text and
      typesense apply `opts.limit ?? DEFAULT`; ES passes `size` and Algolia `hitsPerPage` = DEFAULT
      (the `IndexSearcher` contract takes no per-call limit, so it's their fixed page size, matching
      Go). Test: an omitted limit caps memory results at 10, an explicit limit still overrides.

---

## Workstream 3 — lifecycle & fail-fast

Everything holding a connection needs a close path; everything hitting the network needs a
deadline. Consider one shared decision here (e.g. add `close(): Promise<void>` to each
interface, and standard ioredis options) applied package-by-package.

- [x] **LC-1 (H)** Private ioredis clients with no close path in three packages:
      `cache` (`providers/redis.node.ts:29`), `ratelimiting` (`providers/redis.node.ts:49`),
      `distributedlock` (`providers/redis.node.ts:65`). Connections pin the event loop; graceful
      shutdown impossible. **Fix:** add `close()` to each interface (mirror messagequeue's
      quit-then-disconnect), and accept an injected shared client for connection reuse.
      → `close(): Promise<void>` added to `Cache`/`RateLimiter`/`DistributedLock` and every provider:
      memory/noop/web/postgres are no-ops (postgres's pool is caller-owned), the three redis providers
      `quit()`-then-`disconnect()`. Each redis provider now shares a `buildRedisClient(options)` helper
      that either constructs an owned client or reuses an injected `options.client` (unowned → `close()`
      no-ops so the caller keeps its shared connection). Conformance suites assert `close()` resolves;
      cache's redis test pins owned-quit / quit-reject-fallback-to-disconnect / injected-client-left-open.

- [x] **LC-2 (M)** Default ioredis behavior makes a down Redis _hang_ (~30s offline-queue/retry)
      instead of failing fast — worst for `cache` (a cache in front of a DB must degrade to a miss
      fast) and `distributedlock.acquire`. Set `maxRetriesPerRequest`/`enableOfflineQueue`
      deliberately and expose a timeout knob.
      → `buildRedisClient` sets ioredis options deliberately: `maxRetriesPerRequest: 3` (down from
      ioredis's 20 → a command rejects after a few reconnects instead of ~30s), explicit
      `connectTimeout` and `enableOfflineQueue` (kept `true` — `lazyConnect`'s first command needs the
      queue), and an opt-in `commandTimeout` as the hard fail-fast bound. All four are overridable per
      provider; `commandTimeoutMs`/`connectTimeoutMs` are exposed on each redis config schema and
      threaded through the factories.

- [x] **LC-3 (M)** messagequeue `stop()`/`close()` are sync fire-and-forget — buffered messages
      can drop on shutdown (`src/messagequeue.ts:28,44`; Pub/Sub flush ignored at
      `providers/pubsub.node.ts:87-90`; Kafka `producer.disconnect()` at `kafka.node.ts:90-96`;
      Redis `quit()` at `redis.node.ts:151-156`). Make them `Promise<void>` and await the flush.
      Related **LC-4 (M):** `ConsumerProvider` has no `close()` at all (`src/messagequeue.ts:67-73`)
      — SQS/PubSub/Kafka consumer-side clients leak.
      → **LC-3:** `Publisher.stop()` and `PublisherProvider.close()` are now `Promise<void>` and awaited
      everywhere: Pub/Sub `stop()` awaits `topic.flush()` and provider `close()` flushes every cached
      publisher before `client.close()`; Kafka `stop()` awaits `producer.disconnect()`; Redis provider
      `close()` awaits `quit()`-then-`disconnect()`; SQS/memory/noop resolve. **LC-4:** added
      `ConsumerProvider.close(): Promise<void>` to the interface and every provider — SQS/PubSub destroy
      their client, Kafka disconnects every cached reader, Redis quits each consumer's subscriber socket
      (each consumer now hoists its `sub` to a field + an awaitable `close()` that drains in-flight
      delivery first), memory/noop clear the cache. New tests pin Kafka provider-close → reader
      disconnect.

- [x] **LC-5 (M)** `featureflags` has no shutdown — `OpenFeature.close()` never called; buffered
      LaunchDarkly events lost on exit, pollers keep the process alive
      (`providers/launchdarkly.ts:41`, `posthog.ts:51`, manager at `featureflags.ts:34-75`).
      Related **LC-6 (M):** constant `CLIENT_DOMAIN`s mean a second construction silently rebinds
      the first manager's provider (`launchdarkly.ts:14`, `posthog.ts:13`) — derive domain per call.
      → **LC-5:** added `close(): Promise<void>` to `FeatureFlagManager` (default no-op in
      `BaseFeatureFlagManager`, so static/noop inherit it). The OpenFeature manager overrides it to
      rebind its own domain to `NOOP_PROVIDER`, which drives the displaced vendor provider's `onClose`
      (flush buffered events, stop pollers) — scoped shutdown, not the process-global `OpenFeature.close()`
      that would tear down sibling managers. **LC-6:** the LaunchDarkly/PostHog factories now mint a
      per-call unique domain (`<base>_<n>`) and pass it to the manager, so a second construction no
      longer rebinds the first's provider. New tests pin close→onClose, cross-domain isolation, and the
      domainless no-op.

- [x] **LC-7 (M)** notifications: no APNs/FCM client shutdown (`apns.node.ts:54-56` — apn
      `Provider.shutdown()` exists; `fcm.node.ts:40-53` — apps never `deleteApp`'d);
      `PushNotificationSender` lacks the `close()` that `AsyncNotifier` got.
      → Added `close(): Promise<void>` to `PushNotificationSender` (noop resolves;
      `MultiPlatformPushSender.close()` `allSettled`s both platform senders). The `ApnsClient`/`FcmClient`
      seams gained an optional `close?()`; `newApnsClient` wires it to `provider.shutdown()` and
      `newFcmClient` to `deleteApp(app)`; `ApnsSender`/`FcmSender` expose a `close()` delegating to the
      seam (no-op for a fake without one). New tests pin that `MultiPlatformPushSender.close()` closes
      both clients and no-ops when a platform is absent.

- [x] **LC-8 (M)** messagequeue abort race: `signal` listener registered after `await`s — an
      abort during connect/subscribe is missed and `consume()` never resolves
      (`kafka.node.ts:202-208`, `redis.node.ts:198-207`). Re-check `signal.aborted` after awaits /
      register the listener first.
      → Both Kafka and Redis `consume()` now create the "done" promise and register the abort listener
      synchronously _before_ any `await` (connect/subscribe/run), so an abort landing mid-setup fires
      the same idempotent `#stop()` that resolves `done`. A connect/subscribe rejection also routes
      through `#stop()`. No more hang-forever window.

- [x] **LC-9 (M)** Kafka consumer death is invisible — no `consumer.on('crash'/'disconnect')`;
      a non-retriable error stops flow while `consume()` stays pending and `onError` never fires
      (`kafka.node.ts:163-209`).
      → `consume()` registers `reader.on(events.CRASH)` (fires `onError`; a fatal crash — `restart:
false` — logs at error and `#stop()`s so the caller's await resolves instead of hanging) and
      `events.DISCONNECT` (debug log). New tests prove a fatal crash surfaces via `onError` + resolves
      `consume()` + disconnects the reader, while a retriable crash surfaces but keeps consuming.

- [x] **LC-10 (M)** SQS receive-error path hot-loops with no backoff
      (`providers/sqs.node.ts:194-201`) — bad queue URL/IAM error becomes a tight error loop. Add
      exponential backoff on consecutive receive failures.
      → The receive loop tracks `consecutiveFailures`; each failure logs it and sleeps a full-jitter
      exponential backoff (100ms base, 30s ceiling) via an abort-aware `abortableSleep` before retrying;
      a successful receive resets the counter to 0.

- [x] **LC-11 (M)** Redis consumer has zero backpressure — every message fires
      `void this.#deliver(...)` (`providers/redis.node.ts:188-190`); unbounded concurrency under
      flood. Serial delivery or a bounded queue.
      → Delivery is now serialized: each `messageBuffer` chains its `#deliver` onto a `#tail` promise, so
      at most one handler runs at a time regardless of arrival rate. `close()` awaits `#tail` so a
      graceful shutdown drains the in-flight handler.

- [x] **LC-12 (M)** analytics `shutdown()`/`flush()` have no deadline
      (`src/vendor.ts:91-105`; posthog-node's `shutdown(timeoutMs)` unused at `posthog.node.ts:60`)
      — a wedged flush stalls process exit at exactly the moment flush-on-shutdown must be bounded.
      → `VendorReporter.flush`/`shutdown` now race the sink call against a deadline (`#bounded`,
      default `DEFAULT_ANALYTICS_TIMEOUT_MS = 10s`, overridable per reporter): a sink that outlives it
      is abandoned with a warn instead of hanging. Kept universal (global `setTimeout`, timer cleared in
      `finally`). posthog-node's `shutdown(timeoutMs)` is now passed that deadline so the SDK also gives
      up. New fake-timer tests prove a never-resolving flush and shutdown each resolve after the deadline.

- [x] **LC-13 (M)** database: readiness failures swallow the driver error in a bare `catch {`
      and give up at `debug` level (`src/database.ts:133-137`); `close()` skips the write pool if
      the read pool's `end()` rejects (`database.ts:144-149`). Log the cause at error level;
      `allSettled` the drains.
      → `#waitForPing`'s catch now binds the error and, on exhaustion, logs it at **error** level with
      the cause + `{ connection, attempts }`. `close()` `allSettled`s every distinct pool's `end()` (so
      a failing read drain no longer skips the write pool), logs each failure at error, and rethrows the
      single cause (or an `AggregateError` for multiple). New tests pin the error-level readiness log and
      that the write pool still drains + the error surfaces when the read pool's `end()` rejects.

- [x] **HC-1 (M)** healthcheck has no aggregate deadline — a hanging checker built without
      `timeoutMs` hangs the whole report forever (`packages/healthcheck/src/index.ts:147-152`).
      Default per-check timeout or registry-level deadline.
      → `HealthRegistry` takes a `checkTimeoutMs` option (default 10s, `0` disables) and races every
      checker against it in `#runChecker`: a check that outlives the deadline reports `unhealthy` with a
      timeout error instead of hanging the report. A checker with its own shorter `timeoutMs` still wins
      the race, so this is a pure backstop. New tests pin that a never-resolving checker is bounded (the
      rest of the report still lands) and that `checkTimeoutMs: 0` opts back out.

---

## Workstream 4 — instrumentation sweep

Do after OBS-1..4 (the backbone makes most of this nearly free). The pattern to copy is
`notifications`: wrap operations in `observer.run`, `op.set` the identifying keys,
`op.error` on failure, counters via `makeMetrics` (until OBS-1 lands).

- [x] **INST-1 (H)** httpclient: inject W3C trace context. `observer.run` starts an active span
      but `#buildInit` never calls `propagation.inject()` — no `traceparent` header, every
      distributed trace dies at the service boundary
      (`packages/httpclient/src/providers/fetch.ts:73-111,156-181`). Also add request
      counter/duration histogram by method+status (**INST-1b, M**).
      → `#buildInit` now runs the outgoing `Headers` through `propagation.inject(context.active(), …)`
      (inside `observer.run`'s active span), so `traceparent`/`tracestate` cross the boundary; a
      caller header of the same name is overwritten deliberately. **INST-1b:** constructor mints
      `httpclient.requests` (counter) + `httpclient.request.duration` (ms histogram); a new `#record`
      tags both `{http.request.method, http.response.status_code}` on every response and a transport
      failure records once tagged `status="error"`. New test installs a fake global propagator and
      proves `traceparent` lands on the outgoing request.

- [x] **INST-2 (H)** Dark packages — add spans + counters to the operations that are the
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
    → Every listed operation now runs inside `observer.run` (span + backbone duration/outcome
    metrics) and names its key/id. Per package: **cache** get/set/delete spans, `cache.hits`/
    `cache.misses` counters, key on every miss (shared `support.ts`). **distributedlock**
    acquire/release/refresh spans + `distributedlock.contention` counter tagged by op; the factory
    now threads `deps.observer`, and all 10 messagequeue provider call sites switched to
    `deps.observer ?? makeObserver(...)`. **ratelimiting** `limit` span, `allowed`/`denied`
    counters, key on the denial log. **circuitbreaking** `circuitbreaking.transitions` counter +
    `circuitbreaking.state` gauge (closed=0/half-open=1/open=2) + `circuitbreaking.rejections` in
    `canProceed`; recovery/half-open raised `debug`→`info`, open stays `warn`. **email** all five
    `send()`s wrapped, shared `senderInstruments` (`email_sends`/`email_errors`), recipient-domain
  * vendor request-id on error logs, postmark now passes the wrapped cause. **llm** `complete()`
    span, `llm.tokens.input`/`.output` counters tagged by model, vendor request-id captured on
    errors. **analytics** `analytics.events.sent`/`.dropped` counters (per-event spans skipped for
    the buffered reporter) + background `on("error")` listeners on the posthog-node/segment clients
    routing to a new `onBackgroundError`. **authentication** scrypt/totp `verify` count success/
    failure + debug-log the outcome (never the secret/hash/code). **compression** compress/
    decompress spans with `input.bytes`/`output.bytes` + typed `CompressionError extends
PlatformError` wrapping corrupt input. **healthcheck** per-check span, unhealthy→error /
    degraded→warn logs (HC-1 deadline preserved). **search/Typesense** brought to ES/Algolia parity
    (`observer.run` spans, `op.set` of index/id/query keys, `op.error` recording the error object).
    Full repo green: typecheck + test (40 packages) + lint. New tests pin each package's key
    behavior (miss logs key, denial counts, transition counter/gauge, token counters, background
    drop, verify counts without leaking secrets, typed compression error, unhealthy log, typesense
    span/error offline).

- [x] **INST-3 (M)** notifications: platform-disabling init failures (bad .p8/service account)
      log at `debug` (`src/index.ts:105,114,119`) — raise to error + counter; iOS push silently
      stopping is invisible at production log levels.
      → Both platform-init catches now `logger.error(...)` with the cause + a `{ platform }` tag and
      increment a `notifications.push.init_failures` counter (tagged `platform`); the "no platform
      senders available, using noop" degrade was raised `debug`→`warn`. New test drives a real init
      failure (firebase-admin's `cert()` throws on a missing service-account file) and asserts the
      counter ticks once and the sender falls back to noop.

- [x] **INST-4 (M)** retry: the retry log omits the causing error, exhaustion is completely
      silent, and `RetryLogger` only has `debug` so nothing can ever surface higher
      (`packages/retry/src/retry.ts:4-6,39-56`). Include the error per attempt; warn-level line on
      exhaustion with attempt count.
      → Each retry `debug` line now carries `{ attempt, delayMs, error }`; exhaustion emits a
      `warn`-level `retry exhausted after N attempts` with `{ attempts, error }` before rethrowing.
      `RetryLogger` gained a `warn(message, values?)` method (kept a structural subset of the platform
      `Logger`, so any platform logger still satisfies it) and an optional per-line `values?`. New test
      pins the per-attempt error and the single exhaustion warn.

- [x] **INST-5 (M)** files: `Dir.sub()` silently drops observability — doc says "sharing this
      one's observability" but `sub()` re-opens without deps (`packages/files/src/files.ts:169-172`).
      → `sub()` now reuses the parent's `Files` instance (and thus its observer) via a private static
      `Dir.#openWith(path, files)` that keeps the exists/is-directory validation; `Dir.open` delegates
      to it with a fresh `Files(deps)`. New test injects a recording observer, opens a `sub()`, decodes
      through it, and asserts the observation lands (it never would under the old fresh-`Files` path).

- [x] **INST-6 (L)** Keyless/context-free logs elsewhere: featureflags static provider
      (`providers/static.ts:45` — no flag key); LD SDK logs bypass the injected logger
      (`launchdarkly.ts:36-40` — forward `deps.logger`).
      → static provider's "feature flag not found" now carries `{ key }`. LaunchDarkly factory passes a
      `toLaunchDarklyLogger(ensureLogger(deps.logger))` adapter as the SDK's `logger` option, so LD's
      own diagnostics route through the injected platform logger instead of its console fallback. New
      test pins the static provider naming the key.

- [x] **INST-7 (L)** httpclient records `url.full` post-query-merge on spans/logs
      (`fetch.ts:76,95,99,102`) — query-string tokens land in telemetry; strip or redact query.
      Same class: notification titles on spans (`apns.node.ts:117`, `fcm.node.ts:72`) — PII;
      analytics puts `userId` in error logs (`vendor.ts:71`). Decide a telemetry-PII stance once.
      → Stance adopted: telemetry never carries query-string values, notification/message content, or
      user identifiers. httpclient records a `redactQuery(url)` (query stripped) on the span + error/
      warn logs while the real fetch keeps the full URL; test proves `token=secret` stays on the wire
      but not in `url.full`. apns/fcm dropped `op.set("title", ...)` (docstrings updated); analytics
      `identify` failure no longer logs the `userId`.

---

## Workstream 5 — timeouts, retries, streaming

- [x] **NET-1 (M)** No timeout on vendor calls: `llm` (`anthropic.node.ts:95`,
      `openai.node.ts:90` — the SDKs this package avoids ship a 10-min default; replace it),
      `email` (`resend.ts:64`, `sendgrid.ts:52`, `mailgun.ts:61`, `mailjet.ts:58`). Add
      `AbortSignal.timeout` with a config knob, default on.
      → Both packages route their vendor `fetch` through a shared `resilientFetch` helper
      (`llm/providers/support.ts`, `email/providers/http.ts`) that mints a per-attempt
      `AbortSignal.timeout` (combined with a caller signal via `AbortSignal.any`) and passes it into
      the request. `timeoutMs` (default 30s, `0` disables) is a config knob on every REST provider
      (anthropic/openai, resend/sendgrid/mailgun/mailjet), threaded config→factory→provider. Tests
      pin that a signal lands on the send/completion fetch by default and is absent when disabled.

- [x] **NET-2 (M)** Nothing in the repo uses `@primandproper/retry`, and retry itself lacks the
      features integration needs: no `shouldRetry` predicate (4xx retried alongside 503), no
      `AbortSignal`/cancellation, no total-elapsed cap (`packages/retry/src/retry.ts:39-56`).
      **Fix retry first** (predicate + signal + deadline), then adopt in `llm` + `email` (vendors
      document 429/5xx as retryable) and make httpclient's policy idempotency- and abort-aware
      (`fetch.ts:85-92` — today caller aborts still sleep out full backoff, and POSTs retry on
      network errors with no opt-out).
      → **Retry hardened:** added a `shouldRetry(error, attempt)` predicate (defaults to retry-all),
      per-run `AbortSignal` that cancels the loop _and_ the backoff sleep (`run(op, { signal })`),
      and a `maxElapsedMs` total-elapsed budget that gives up before sleeping past it. Extracted a
      standalone `backoffDelay()` (addresses the ES-1 note that retry only exported `run()`).
      **httpclient:** retry now only fires for idempotent methods (GET/PUT/DELETE) or an explicit
      per-request `idempotent: true`, and the caller's signal drives the retry loop so an abort cuts
      the backoff immediately instead of sleeping it out. **llm + email:** both adopt retry via the
      `resilientFetch` helper — a retryable-status response (408/429/5xx) drives retries carrying a
      marker error, a 4xx/2xx returns unchanged for the provider's own handling, and once retries
      exhaust the final response surfaces so the provider still logs the vendor's status/body. Retry
      is **opt-in** (off unless a `retry` config block is set) because a send/completion isn't
      idempotent — enabling it accepts a possible double-deliver/double-bill on an ambiguous failure.
      Tests across all four packages pin: predicate/signal/deadline (retry), idempotency + abort
      (httpclient), retry-503-then-surface, no-retry-4xx, network-retry (llm + email).

- [x] **STRM-1 (M)** compression is bytes-only — built _on_ `CompressionStream` then collapses
      it (`compression.ts:6-11,30`, `providers/web-standard.ts:37`). Add a stream-in/stream-out
      surface next to the bytes one.
      → `Compressor` gained `compressStream`/`decompressStream(source: ReadableStream<Uint8Array>):
    ReadableStream<Uint8Array>` next to the byte methods. Web-standard pipes straight through
      `CompressionStream`/`DecompressionStream` (never collapsing to bytes); zlib bridges its
      incremental `node:zlib` transforms to web streams via `Duplex.toWeb` (new `pipeThroughDuplex`
      helper), so brotli streams too; noop returns the source untouched. Codec errors surface on the
      returned stream (deferred to read time), documented on the interface. Conformance suite now
      round-trips every provider through the streaming surface and pins that streamed output decodes
      via the one-shot path (same wire format).

- [x] **STRM-2 (M)** `decodeRequest` buffers unbounded attacker-typed bodies and picks the
      parser from the client's Content-Type, outside `instrument()`
      (`packages/encoding/src/encoding.ts:192-199`). Add a max-size option, an allowed-codecs
      option, and move the body read inside instrumentation.
      → `DefaultServerEncoderDecoder` gained a `ServerEncoderDecoderOptions` (third ctor arg,
      threaded from config): `maxRequestBytes` (default 1 MiB, `0` disables) and
      `allowedContentTypes` (undefined = all). `decodeRequest` now runs entirely inside a new
      `instrumentAsync` (span covers the read); a `#readBounded` streams the body via the reader,
      rejecting early on a `Content-Length` over the cap _and_ counting bytes as it drains (so an
      absent/lying header can't smuggle a larger payload), and `#assertContentTypeAllowed` gates the
      parser selection. Two typed errors — `RequestBodyTooLargeError` (→413) and
      `UnsupportedContentTypeError` (→415) — pass through `instrument` unwrapped (a shared
      `recordEncodingError` re-wraps only non-`PlatformError` codec failures into `EncodingError`).
      Tests pin: streamed-over-cap, declared-length-over-cap, within-cap, disallowed and allowed CTs.

- [x] **STRM-3 (M)** llm has no streaming surface at all (`src/llm.ts:43-48`) — long
      generations buffer fully and are likeliest to hit intermediary timeouts. At minimum document
      the seam; ideally `completeStream()` (SSE parsing for both vendors).
      → Implemented `completeStream(request): AsyncIterable<CompletionChunk>` on `LLMProvider` and
      all four providers. A shared `sseDataLines()` (support.ts) incrementally decodes the response
      body and yields each SSE `data:` payload (buffering partial lines across chunks, honoring
      OpenAI's `[DONE]` sentinel). Anthropic maps `message_start`/`content_block_delta`/
      `message_delta` events to text deltas + terminal `usage`/`stopReason`; OpenAI sets
      `stream: true` + `stream_options.include_usage` and maps `choices[].delta.content` +
      the usage-only tail chunk. Both record the input/output token counters from the stream and
      impose **no timeout** (a long generation outlives one; only `request.signal` cancels) and **no
      retry** (no mid-stream resume point) — documented on the interface. Added `signal?` to
      `CompletionRequest` (threaded into `complete()` too). echo/noop yield a single delta + terminal
      chunk. Tests parse real SSE `ReadableStream` bodies for both vendors (deltas, stop reason,
      usage, `stream:true`/`include_usage` on the wire) and assert a non-2xx stream throws.

- [x] **PERF-1 (M)** `RedisCache` lacks `BatchCache` while the memory provider has it — tests
      batch, production does N round trips (`providers/redis.node.ts:21` vs `memory.ts:26`).
      Implement with `MGET` / pipeline of `SET EX`.
      → `RedisCache` now `implements BatchCache<T>`. `getMany` does one `MGET` (missing keys omitted,
      corrupt entries degraded to a miss + dropped via a batched `DEL`, mirroring `get`'s heal
      policy); `setMany` queues every write on one `pipeline()` (`SET`/`SET EX`) for a single round
      trip, wrapping an encode failure and surfacing the first per-command pipeline error with
      context. Both run inside `observer.run` tagging the key count. Redis test's ioredis mock gained
      `mget`/`pipeline`; new tests pin getMany hits/misses, corrupt-drop, setMany pipeline write, and
      the encode-wrap.

- [x] **PERF-2 (M)** secrets: no caching — every `get` is a remote round trip; a Secret Manager
      blip is an outage (`gcp.node.ts:89-104`, `ssm.node.ts:106-122`, `kubectl.node.ts:112-130`).
      Short-TTL memoization + in-flight dedup (compose with `@primandproper/cache`). Kubectl
      additionally re-fetches and decodes the whole secret per key (`kubectl.node.ts:63-74`).
      → New `CachingSecretSource` decorator (`providers/caching.ts`) wraps any source with short-TTL
      memoization (composes `@primandproper/cache` via `provideCache({provider:"memory",expiryMs})`,
      or an injected `Cache<string>`) plus synchronous in-flight de-duplication (an `#inflight` map
      keyed by lookup, registered before the first `await`, so concurrent reads collapse to one
      upstream call — which also keeps serving during a provider blip). Only positive results are
      cached; a miss re-checks each time so a newly-created secret is seen promptly. The factory
      wraps the remote providers (gcp/ssm/kubectl) by default via a new `cache` config block
      (`enabled` default true, `ttlMs` default 30s; `enabled:false`/`ttlMs:0` opts out); local
      sources (env/static/noop) are never wrapped. Added `@primandproper/cache` dep. Tests pin
      memoize-within-TTL, don't-cache-miss, concurrent-dedup (1 upstream call for 3 reads), and
      close-propagation; factory tests updated for the default wrap + a caching-disabled bare source.
      → **Not addressed:** kubectl still decodes the whole secret once per _distinct_ key of the same
      secret (the decorator caches per full `secret-name/key`, so it only dedups repeats of the same
      key). Left as a smaller follow-up — a secret-level decode cache inside `RealK8sReader`.

- [x] **PERF-3 (L)** Lua scripts sent in full per call — use `defineCommand`/EVALSHA
      (ratelimiting `redis.node.ts:58`; distributedlock `redis.node.ts:108,120`).
      → Both providers now register their scripts via ioredis `defineCommand` in the constructor
      (ratelimiting `rlFixedWindow`; distributedlock `dlRelease`/`dlRefresh`, distinct names so a
      shared injected client can't collide), and call them as custom commands — ioredis issues
      EVALSHA and transparently falls back to EVAL + re-caches on NOSCRIPT, so the full script body
      no longer ships every call. A small typed-client interface + `as unknown as` cast keeps the
      dynamically-added methods type-safe. Unit suites (memory/postgres conformance) stay green; the
      redis paths are live-only tests.

- [x] **PERF-4 (L)** Byte-at-a-time base64 building (`cryptography/src/base64.ts:8-14`,
      `random/src/encoding.ts:43-48`) — chunked conversion.
      → Both encoders now build the latin1 binary string in `0x8000`-byte chunks via
      `String.fromCharCode(...subarray)` (O(n/CHUNK) concatenations instead of one `+=` per byte,
      staying under the spread argument-count ceiling) before `btoa`. cryptography extracted a
      `bytesToBinaryString` helper; random inlined the same loop. New tests round-trip / encode a
      payload larger than two chunks to exercise the boundary. Left `bytesToHex`/`bytesToBase32`
      untouched (not flagged, and unrelated to base64).

- [x] **PERF-5 (L)** search has no bulk-index path (`document-index.ts:18-25`) — N docs = N
      sequential round trips despite `_bulk`/`saveObjects`/`import()` existing on all three
      backends. At least leave the seam.
      → Added an optional bulk seam on both index families, mirroring cache's `isBatchCache`:
      `BulkIndexManager.indexMany(BulkDocument[])` + `isBulkIndexManager` on the `IndexManager`
      family, and `BulkTextIndex.indexMany(TextDocument[])` + `isBulkTextIndex` on the `TextIndex`
      family. Implemented as a single round trip on all three backends — Elasticsearch `client.bulk`
      (action+source lines, surfaces item errors), Algolia `saveObjects`, Typesense
      `documents().import({action:"upsert"})` — plus MemoryTextIndex (loops, refactored a shared
      `#store`) and both noops. All go through `observer.run` tagging the batch length. Exported via
      the package barrel. Tests pin the memory bulk path + guard and the noop document bulk + guard
      (the three vendor providers are live-only).

---

## Workstream 6 — remaining medium/low backlog (by package)

Security-adjacent first.

- [x] **SEC-1 (M)** `Dir` has no path containment — `resolve()` is bare `join`; `../` escapes
      silently and every method routes through it (`packages/files/src/files.ts:165-167`). Copy
      uploads' `FilesystemBucket.#pathFor`.
      → `Dir.resolve()` now `resolve()`s the joined path and throws a new `PathEscapesBaseError`
      unless the result is the base itself or sits under `base + sep` (the uploads containment check).
      Every `Dir` method routes through `resolve()`, so all are guarded and fail fast (synchronous
      throw). Test pins `../` and `nested/../../` escapes rejecting while an in-base name still resolves.
- [x] **SEC-2 (M)** cookies: no `httpOnly` server default and no config field for it
      (`config.ts:7-11`); no signing/integrity option or warning anywhere (compose a signed
      provider with `@primandproper/cryptography`, or document loudly).
      → Added `httpOnly` to `DefaultCookieOptionsSchema` (schema default `false` — the browser
      can't set `HttpOnly`, so it stays a plain `boolean` for `exactOptionalPropertyTypes`); the
      **Node** config overrides its `defaults` default to `{ httpOnly: true }`, so server cookies are
      HttpOnly unless the caller opts out. Took the **document-loudly** route on signing: a prominent
      note on the config schema states stores do not sign/integrity-protect values and points at
      composing `@primandproper/cryptography`. Store `defaults` option widened to `CookieOptions`
      (partial). Tests pin the Node default + opt-out.
- [x] **SEC-3 (L)** Pusher defaults to non-TLS (`notifications/src/config.ts:9`) — flip default.
      → `PusherConfigSchema.secure` now defaults `true` and `newPusherClient`'s fallback is
      `options.secure ?? true`, so both the config path and direct construction use TLS unless a
      caller explicitly opts out for local dev.
- [x] **SEC-4 (L)** scrypt `verify()` trusts embedded cost params — unbounded `N` from an
      untrusted hash allocates GBs (`providers/scrypt.ts:126-157,42`); add ceilings.
      → `parseEncoded` now rejects (→ malformed → `verify` returns `false`, never throws) any hash
      whose `N` isn't a power of two or exceeds `MAX_COST=2^20`, or whose `r`/`p` exceed
      `MAX_BLOCK_SIZE=32`/`MAX_PARALLELIZATION=16`. A hostile `N=2^30` hash can no longer drive scrypt
      to allocate GBs. Test pins that such a hash verifies `false` without attempting the derivation.
- [x] **SEC-5 (L)** auth polish: TOTP error message leaks a secret char + `generate()` throws
      raw (`providers/totp.ts:47-71,105-107`); scrypt `cost` not schema-validated as power of two,
      `hash()` unwrapped (`config.ts:9`, `providers/scrypt.ts:81-93`); token generator accepts
      length 0 (`providers/tokens.ts:18-20`); no TOTP replay-prevention seam (docstring at minimum).
      → New `errors.ts` (adds `@primandproper/errors` dep) with `InvalidScryptCostError`,
      `PasswordHashError`, `InvalidTOTPSecretError`, `InvalidTokenLengthError`. base32Decode now
      throws `InvalidTOTPSecretError` (no secret char in the message); `generate()`/`verify()` doc
      the typed throw and `verify()` documents the missing replay-prevention seam (caller records
      accepted counters). `ScryptConfigSchema.cost` refined power-of-two; `ScryptHasher` ctor throws
      `InvalidScryptCostError` on a non-power-of-two cost; `hash()` wraps failures in
      `PasswordHashError`. `RandomTokenGenerator.generate` rejects non-positive/non-integer lengths.
      Tests pin each.
- [x] **SEC-6 (L)** cryptography: bad base64 key throws bare `InvalidCharacterError` at
      construction, wrong-length key surfaces only on first use (`config.ts:8-25`, `aes-gcm.ts:57,
99-102`, `salsa20.ts:40`) — validate decodability + length in the factory.
      → Added `decodeBase64Key()` (base64.ts) that turns `atob`'s bare `InvalidCharacterError` into a
      clear "value is not valid base64" error; both `AesGcmEncryptor` and `Salsa20Encryptor` use it.
      AES-GCM now validates key length **eagerly in the constructor** (16/24/32) like Salsa20 already
      did, so a wrong-length key fails at construction rather than first encrypt/decrypt. Both paths
      are hit by the factory and by direct construction. Tests pin bad-base64 and wrong-length →
      construction throw.

- [x] **DL-1 (M)** distributedlock: memory provider's `refresh` revives expired leases —
      no expiry check, diverging from redis/postgres (`providers/memory.ts:87-94` vs `#owns` at
      72-75). Align semantics; extend the conformance suite to pin it.
      → Memory `refresh` now guards on `#owns` (token AND unexpired) instead of token-only, so it can
      no longer revive a lapsed lease. Pinned by a new test (refresh after expiry returns `false` and
      leaves the key acquirable). Fixed alongside LOCK-1.
- [x] **DL-2 (L)** Expired residue never cleaned: memory `Map` entries and Postgres rows linger
      forever (`memory.ts:41`, `postgres.node.ts:60-68`).
      → Memory `acquire` now runs a `#sweepExpired()` first (drops every lapsed lease, not just the
      contended key; records `leases.swept` on the span when >0) so an acquired-then-abandoned key no
      longer lingers. Postgres: acquire already reclaims a _contended_ key's expired row via its upsert;
      added a `cleanupExpired()` maintenance call (`DELETE ... WHERE expires_at < now()`, returns count)
      for abandoned rows — deliberately caller-scheduled rather than a per-`acquire` full-table scan on
      the hot path. Tests pin the memory sweep and the postgres delete SQL/count (live lifecycle stays
      env-gated).
- [x] **MQ-2 (L)** Consumer cache keyed by topic ignores the handler — second
      `provideConsumer(topic, otherHandler)` silently returns the first consumer
      (`providers/support.ts:63-69`). Throw on mismatch or key by both.
      → `TopicCache.getOrBuild` takes an optional `identity` (the handler); a repeat
      `provideConsumer(topic, otherHandler)` rejects with new `ErrConsumerHandlerMismatch` instead of
      returning the first consumer, while same topic+handler still returns the memoized one. Publishers
      omit `identity` (plain topic-keyed). Wired through all 5 consumer providers. Tests pin reuse +
      mismatch rejection.
- [x] **MQ-3 (L)** Consumer metrics asymmetry: `_consumed` increments before the handler,
      no error counter — a 100%-failing consumer looks healthy in metrics (`support.ts:38-43`).
      → `consumerInstruments(deps, topic)` returns `{ consumed, consume_errors }`; across all 5 providers
      `consumed` now increments **after** a successful handler and a `{topic}_consume_errors` counter
      increments in the failure catch, so a fully-failing consumer is visible. Test drives fail-then-
      succeed → `topic_consumed=1`, `topic_consume_errors=1`.
- [x] **MQ-4 (L)** `parseAddress` breaks IPv6 (`redis.node.ts:49-55`).
      → Rewrote `parseAddress` (now exported for testing) to handle bracketed IPv6 (`[::1]`/`[::1]:6379`),
      single-colon `host:port`, and bare unbracketed IPv6 literals (whole string is the host). Tests cover
      IPv4, bare host, bracketed IPv6 ±port, and bare IPv6.
- [x] **DB-3 (L)** `DatabaseNotReadyError` exported + documented, never thrown
      (`database.ts:67-73`). DSN helpers mishandle special chars (`config.ts:50,59`). sqlite adapter
      routes `reader`-absent writes to `.all()` contradicting its own doc, and `prepare` throws sync
      from an async-typed method (`adapters.ts:53-57,82-86`).
      → Added `ensureReady()` to the client — a fail-fast variant of `isReady()` that throws
      `DatabaseNotReadyError` when not ready (isReady keeps its boolean contract; the driver cause is
      already error-logged by LC-13). `postgresKeyValue` now libpq-quotes each component (`pgKeyValueQuote`:
      single-quote + backslash-escape values with whitespace/`'`/`\`) so a `p@ss word` password no longer
      truncates the DSN; `postgresUri`/`mysqlDsn` percent-encode the database segment too. sqlite `query`
      is now `async` (a synchronous `prepare` throw rejects the promise instead of escaping) and routes by
      `reader` truthiness — a `reader`-absent statement goes to `run()`, not `all()`. Tests pin ensureReady
      resolve/reject, DSN escaping/encoding, sqlite reader-absent→run, and prepare-throws→reject.
- [x] **CACHE-2 (M)** InMemoryCache unbounded, read-time-only eviction
      (`providers/memory.ts:27,41-53`) — cap + sweep (same class: uploads `MemoryBucket`, CB
      partitions map `partitioned.ts:120,130-137` — consider one shared bounded-map utility).
      → `InMemoryCache` gained a `maxEntries` cap (default 100,000; `0` disables). On a new key at the
      cap, `#evictIfNeeded()` sweeps expired entries first (the ones that leaked under read-time-only
      eviction) then evicts oldest-inserted until under the cap — amortized O(n), only at the boundary.
      Cap threaded through the node/browser config (`maxEntries`) + both factories. Tests pin oldest
      eviction, expired-sweep-before-live-eviction, and unbounded-when-0. (Left the shared bounded-map
      utility for CB/uploads as a separate refactor — kept the fix local to cache.)
- [x] **CACHE-3 (L)** Provider semantic drift: memory returns by reference (mutations poison the
      cache), Redis returns a JSON clone that mangles Dates/Maps — document, or structuredClone in
      memory. `WebStorageCache.set` doesn't handle `QuotaExceededError` (`web.browser.ts:61`) —
      a routine failure, not exceptional.
      → Memory now `structuredClone`s on both `set` (isolates the stored copy from later caller
      mutation) and `get` (isolates the returned copy), matching the isolation Redis gets from
      serialization. Documented the remaining type-fidelity drift on the class (structuredClone keeps
      `Date`/`Map`/`Set`; Redis's JSON round-trip doesn't — stay JSON-safe for portability).
      `WebStorageCache.set` now catches a `QuotaExceededError` (matched by name/code, incl. Firefox's
      legacy 1014) and degrades to a warn + skipped set; non-quota errors still rethrow. Tests pin
      clone isolation both directions, quota→skip, and non-quota→rethrow.
- [x] **RL-3 (L)** Redis rate limiter: no TTL self-heal (a TTL-less counter denies forever —
      add `if pttl < 0 then PEXPIRE` to the script, `redis.node.ts:30-37,68`); raw ioredis errors
      unwrapped with no fail-open/closed policy (`redis.node.ts:58-64`); memory default on Node
      means multi-instance services silently get per-process limits (doc/warn, `config.ts:24`).
      → Lua script self-heals: after `INCRBY` it reads `PTTL` and re-arms `PEXPIRE windowMs` when
      `pttl < 0` (covers first-hit and a counter that lost its TTL). `limit()` now catches ioredis
      errors, `wrap()`s them with the key, logs at error, and applies an explicit `failOpen` policy
      (default `false` = **fail-closed**: deny with full `retryAfterMs`; `true` = admit at capacity) —
      wired through `RedisConfigSchema`→factory, plus a `ratelimiting.errors` counter. The memory
      default's per-process semantics (≈ `limit × instances` behind a LB) documented on the Node config.
      Tests pin fail-closed vs fail-open on an injected failing client, the self-heal, and the schema
      default (redis path otherwise live-only).
- [x] **SRCH-2 (L)** ES: index-name case mismatch between exists/create/use
      (`elasticsearch.node.ts:121-123`); delete-of-missing trips the circuit breaker
      (`elasticsearch.node.ts:203-209` — treat 404 as no-op like the Typesense sibling).
      → The ES provider lowercases `indexName` once in the constructor so exists/create/index/search/
      delete all address the same index; `delete` treats a 404 (`isElasticNotFound`) as a no-op success
      (`cb.succeeded`, no throw) instead of tripping the breaker, matching the Typesense sibling. New
      offline test (mocked `@elastic/elasticsearch`) proves the shared lowercased index, 404-delete-noop,
      non-404 still trips the breaker, and an open breaker never reaches the SDK. Live flow stays env-gated.
- [x] **HC-2 (L)** healthcheck: caller-initiated aborts read as `unhealthy` — distinguish
      AbortError (`src/index.ts:58-67`).
      → Added `isAbortError`; a caller-signal abort (`signal.aborted && isAbortError(err)`) now propagates
      instead of resolving to `unhealthy`. The HC-1 per-check timeout backstop rejects with a plain (non-
      Abort) timeout error, so a timed-out check still reports `unhealthy`. Tests pin both the abort
      propagation and the preserved-timeout behavior.
- [x] **ES-5 (L)** eventstream: `noop` default transport connects to nothing silently
      (`config.ts:10` — warn on construction); SSE named-event listeners never removed
      (`sse.ts:80-84,87-97`); lifecycle events debug-only.
      → `NoopEventStream` now `logger.warn`s once on construction that the transport is inert (both
      factories pass `deps`). SSE named-event listeners are tracked and `removeEventListener`'d in
      `#detachSource` (added `removeEventListener` to `EventSourceLike`), so a reconnect/close leaves
      nothing attached. Lifecycle levels raised: connection-open → `info`, SSE fatal close → `warn`.
      Tests pin listener removal on close and the noop warn.
- [x] **UP-3 (L)** uploads: `ErrCircuitBroken` is a shared singleton (stack points at module
      load — same for notifications' `ErrPlatformNotSupported`, `mobile.ts:59-61`; make factories);
      no max-size backstop; `NoopUploadManager.signedURL` returns `""` instead of rejecting
      (`providers/noop.ts:51-53`).
      → `ErrCircuitBroken`→`newCircuitBrokenError()` (+ exported `CIRCUIT_BROKEN_CODE`) and
      notifications' `ErrPlatformNotSupported`→`newPlatformNotSupportedError()` factories, each minting a
      fresh throw-site stack; throw sites/barrels updated, identity-matching tests rewritten to match by
      code. Added a `maxSizeBytes` knob (default `0`=off): `Uploader.save` rejects an oversize byte body
      up front and wraps a stream body in `limitStream()` that errors mid-transfer (no buffering) →
      `newFileTooLargeError()`. `NoopUploadManager.signedURL` now rejects with `SigningUnsupportedError`.
      Tests pin oversize byte+stream rejection, default-off, and noop signing rejection.
- [x] **EM-1 (L)** email: Resend `ping()` uses undocumented `OPTIONS /emails` (not a real
      health check); unguarded `response.json()` on 2xx (`mailgun.ts:76`, `mailjet.ts:73`,
      `resend.ts:79`); duplicated divergent `FetchLike` exports (`resend.ts:17-56` vs
      `providers/http.ts:4-14`, both exported from `index.ts:17-18`).
      → Added `parseJsonBody<T>()` (`providers/http.ts`; empty/non-JSON body → `undefined`, never
      throws); resend/mailgun/mailjet parse success responses through it so a 2xx with an empty body no
      longer fails an accepted send. Resend `ping()` switched from the undocumented unauthenticated
      `OPTIONS /emails` to a real authenticated `GET /domains`. `FetchLike` was already consolidated to
      the single `http.ts` definition by the NET refactor (resend re-exports it) — no divergent copy
      remains. Tests pin empty/non-JSON 2xx and the new ping endpoint.
- [x] **LLM-1 (L)** `ping()` always succeeds — validate the key against a free authenticated
      endpoint (`GET /v1/models`) (`anthropic.node.ts:136-138`, `openai.node.ts:130-132`). Same
      pattern: secrets gcp/ssm/kubectl `ping()` unconditionally resolves
      (`gcp.node.ts:111-113`, `ssm.node.ts:129-131`, `kubectl.node.ts:136-138`).
      → llm anthropic/openai `ping()` was already a real authenticated `GET /v1/models` via
      `resilientFetch` (verified — no change). secrets gcp/ssm/kubectl `ping()` no longer
      unconditionally resolve: each probes a sentinel name through its accessor seam inside
      `observer.run("ping")` — a NOT_FOUND/404 resolves (endpoint + creds work) while an auth/network
      error is `op.error`-recorded and rethrown. Added a "ping rejects on backend error" test for all
      three via the injected fakes; live vendor calls stay live-only.
- [x] **AN-2 (L)** analytics: browser Segment `load()` failures unobserved
      (`segment.browser.ts:30-32`); unknown-source warn allocates + spams per call
      (`multisource.ts:91-94`); PostHog `DEFAULT_HOST` is the legacy endpoint — use
      `us.i.posthog.com` (`posthog.node.ts:10`, `posthog.browser.ts:10`).
      → `MultiSourceReporter` warns once per unknown source (a `#warnedSources` set) and reuses one
      shared `NoopReporter` instead of allocating a `.with()` child + new noop per call. Browser
      `provideSegment` now `.catch`es async `load()` failures — logs at error + ticks
      `analytics.source.load_failures` (tagged `source`). PostHog `DEFAULT_HOST` changed
      `app.posthog.com`→`us.i.posthog.com` (node + browser; posthog test updated). New warn-once test.
- [x] **FLAG-2 (L)** static provider `evaluate` casts unchecked (`static.ts:49`).
      → `evaluate` no longer blind-casts `resolved as T`: a `sameJsonType`/`jsonType` guard
      (null/array/object/primitive) checks the stored value against the requested type; on mismatch
      it returns the caller's default, `logger.warn`s `{ key, expected, actual }`, and ticks
      `featureflags.evaluation.errors` tagged `error_code: "TYPE_MISMATCH"` (consistent with FLAG-1).
      Test pins string-vs-boolean mismatch → default + warn, and matching type → value.
- [x] **ID-1 (L)** ULID `isValid` accepts timestamp-overflow IDs (spec caps first char at `7`;
      `packages/identifiers/src/ulid.ts:7,30-32`).
      → `isValid` pattern tightened to `/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/`, so a leading char `8`–`Z`
      (a 48-bit-timestamp overflow) is rejected while `0`–`7` still pass. Test pins `8…`/`Z…` reject,
      `7…` accepts.
- [x] **QR-1 (L)** qrcodes: raw library errors unwrapped (`src/qrcodes.ts:57-67`).
      → Added `@primandproper/errors` dep + `QRCodeError extends PlatformError` (`qrcodes/render-failed`)
      carrying the raw library error as `cause`. `toDataUrl`/`toSvg`/`toBuffer` now catch and rethrow the
      typed error (format in the message); exported from the barrel. Test drives an over-capacity payload
      and asserts each method rejects with a `QRCodeError` whose `cause` is set.
- [x] **COOK-3 (L)** cookies: no size guard — >4093 bytes silently dropped by browsers; warn.
      → Added `MAX_COOKIE_BYTES = 4093` + `cookieByteLength()` (UTF-8 via `TextEncoder`) to serialize;
      both stores `logger.warn` (never throw) with `{ name, bytes, limit }` when a serialized cookie
      exceeds it, then queue/write it anyway. Test pins warn-on-oversize + no-warn-on-normal.

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
