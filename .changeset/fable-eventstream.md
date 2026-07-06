---
"@primandproper/eventstream": minor
---

Widen the injectable `EventSourceLike` interface with required `readyState` and `removeEventListener` members. Breaking for custom `EventSourceLike` implementations (standard EventSource implementations are unaffected). Adds heartbeat and reconnect options.
