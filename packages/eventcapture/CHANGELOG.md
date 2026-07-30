# @primandproper/eventcapture

## 0.1.0

### Minor Changes

- 99bdec6: Add `@primandproper/eventcapture`, the port of platform-go's `eventcapture`. A `Recorder` whose
  `record()` is a non-blocking bounded-buffer push (a full buffer drops and counts rather than
  blocking or growing), draining off the hot path through a pluggable `Sink` whose failures are
  counted and logged instead of surfaced. Ships a bounded `Aggregator` for per-(key, window)
  rollups with an overflow counter, and — the modality decision — is isomorphic: a size-rotated
  JSONL file sink on Node, a batched `fetch`/`sendBeacon` sink in the browser, behind one factory
  signature.
