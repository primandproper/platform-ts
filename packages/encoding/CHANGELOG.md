# @primandproper/encoding

## 0.1.1

### Patch Changes

- a124406: Add request body size limits and content-type allow-listing, with `RequestBodyTooLargeError` and `UnsupportedContentTypeError`.
- Updated dependencies [a124406]
- Updated dependencies [a124406]
  - @primandproper/errors@0.0.2
  - @primandproper/observability@0.1.0

## 0.1.0

### Minor Changes

- 19b79dc: add `@primandproper/encoding`: a Universal multi-format encoding package porting
  `platform-go/encoding`. Provides a byte-level `Encoder` and a Fetch-based `ServerEncoderDecoder`
  over JSON, YAML, XML, and TOML, with `provide*` factories, content-type negotiation, injected
  observability, and package-level convenience helpers.
