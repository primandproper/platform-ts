---
"@primandproper/distributedlock": minor
---

Change `Lock.release()` and `Lock.refresh()` to return `Promise<boolean>` (was `Promise<void>`) and add a required `close()` to `DistributedLock`. Breaking for callers and implementers. Adds command/connect timeouts.
