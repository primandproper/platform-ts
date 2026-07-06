# @primandproper/database

## 0.1.0

### Minor Changes

- a124406: Add a required `ensureReady()` method to `DatabaseClient` and change `mysqlDsn()` output to a `mysql://` URL. Breaking for custom `DatabaseClient` implementers and consumers of the previous DSN format. Adds pool-settings helpers.

### Patch Changes

- Updated dependencies [a124406]
- Updated dependencies [a124406]
  - @primandproper/errors@0.0.2
  - @primandproper/observability@0.1.0
