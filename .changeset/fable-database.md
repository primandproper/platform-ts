---
"@primandproper/database": minor
---

Add a required `ensureReady()` method to `DatabaseClient` and change `mysqlDsn()` output to a `mysql://` URL. Breaking for custom `DatabaseClient` implementers and consumers of the previous DSN format. Adds pool-settings helpers.
