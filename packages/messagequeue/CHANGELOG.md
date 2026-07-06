# @primandproper/messagequeue

## 0.2.0

### Minor Changes

- a124406: Make `Publisher.stop()` and `PublisherProvider.close()` async (now return `Promise<void>`) and add a required `close()` to `ConsumerProvider`. Breaking for callers and implementers.

### Patch Changes

- Updated dependencies [a124406]
- Updated dependencies [a124406]
  - @primandproper/errors@0.0.2
  - @primandproper/observability@0.1.0

## 0.1.0

### Minor Changes

- db7c3ec: rewrite `messagequeue` as a faithful port of `platform-go/messagequeue`. **Breaking:** the previous
  combined `MessageQueue` interface (`publish(topic, message)` / `subscribe`, Redis Streams) is
  replaced by Go's actual shape — separate `PublisherProvider` and `ConsumerProvider` roots that hand
  out topic-bound `Publisher`s (`publish(data)` / `publishAsync(data)` / `stop()`) and `Consumer`s
  (`consume(signal, onError)`), with a raw-bytes `ConsumerFunc`. `provideMessageQueue` is gone; use
  `providePublisherProvider(config, deps)` and `provideConsumerProvider(config, deps)` (mirroring Go's
  `ProvidePublisherProvider` / `ProvideConsumerProvider`).

  Go's `context`/`stopChan`/`errors`-channel `Consume` signature is translated idiomatically: an
  `AbortSignal` unifies cancellation and stop, and an `onError` callback stands in for the errors
  channel. Payloads are JSON-encoded on publish and delivered to handlers as `Uint8Array`, matching
  Go's `encoding.ClientEncoder` + `[]byte` handlers.

  Providers now cover the full Go roster plus a local-first bonus: **redis** (faithful PUB/SUB via
  ioredis, replacing the old Streams design — including the SUBSCRIBE-confirmation race fix), **sqs**
  (`@aws-sdk/client-sqs`, long-poll + delete-on-success), **pubsub** (`@google-cloud/pubsub`,
  ack/nack), **kafka** (`kafkajs`, manual commit-after-handle), **noop**, and **memory** (an
  in-process broker, not in Go, for zero-infrastructure tests and single-process apps). `QueuesConfig`
  (the platform topic-name set) is ported as a Zod schema. `ErrEmptyTopicName` mirrors Go's sentinel.
