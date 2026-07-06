# @primandproper/distributedlock

## 0.1.0

### Minor Changes

- a124406: Change `Lock.release()` and `Lock.refresh()` to return `Promise<boolean>` (was `Promise<void>`) and add a required `close()` to `DistributedLock`. Breaking for callers and implementers. Adds command/connect timeouts.

### Patch Changes

- Updated dependencies [a124406]
- Updated dependencies [a124406]
- Updated dependencies [a124406]
  - @primandproper/database@0.1.0
  - @primandproper/errors@0.0.2
  - @primandproper/observability@0.1.0
