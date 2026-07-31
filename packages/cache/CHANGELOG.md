# @primandproper/cache

## 0.2.0

### Minor Changes

- 3d5baf6: Add a per-entry TTL to `Cache.set` and `BatchCache.setMany` via an optional `CacheSetOptions`
  bag, so one cache instance can write entries with different lifetimes — the shape the
  `idempotency` port needs, where a short-lived in-flight claim and a long-lived result record
  share a store. Existing call sites are unchanged and keep the provider's configured expiry.

  The contract is pinned on the interface and implemented once in `resolveTtlMs`, so providers
  cannot drift: an absent, zero, or negative `ttlMs` means "keep the configured expiry" (matching
  the Go platform's `WithExpiry` setters), not "never expire". Honoured by memory, redis, web
  storage, and noop, and asserted by the provider-agnostic conformance suite.

  Redis now applies expiry with `PX` (milliseconds) rather than `EX` (seconds), so a TTL survives
  the round trip at the precision the millisecond-denominated interface advertises — `EX` rounded
  a 1500ms TTL up to 2s.

## 0.1.0

### Minor Changes

- a124406: Add a required `close()` method to the `Cache` and `BatchCache` interfaces. Breaking for external `Cache` implementers. New config: `maxEntries`, `commandTimeoutMs`, `connectTimeoutMs`.

### Patch Changes

- Updated dependencies [a124406]
- Updated dependencies [a124406]
  - @primandproper/errors@0.0.2
  - @primandproper/observability@0.1.0
