---
"@primandproper/messagequeue": minor
---

Make `Publisher.stop()` and `PublisherProvider.close()` async (now return `Promise<void>`) and add a required `close()` to `ConsumerProvider`. Breaking for callers and implementers.
