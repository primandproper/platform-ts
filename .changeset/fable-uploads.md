---
"@primandproper/uploads": minor
---

Replace the `ErrCircuitBroken` sentinel export with `newCircuitBrokenError()` and `CIRCUIT_BROKEN_CODE`. Breaking for code importing or comparing against `ErrCircuitBroken`. Adds `maxSizeBytes` config and `newFileTooLargeError()`.
