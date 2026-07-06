---
"@primandproper/cache": minor
---

Add a required `close()` method to the `Cache` and `BatchCache` interfaces. Breaking for external `Cache` implementers. New config: `maxEntries`, `commandTimeoutMs`, `connectTimeoutMs`.
