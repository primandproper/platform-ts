# @primandproper/cryptography

## 0.2.0

### Minor Changes

- a124406: Add a required `readonly authenticated: boolean` member to the `Encryptor` interface. Breaking for external `Encryptor` implementers. AES-GCM now validates key length at construction.

### Patch Changes

- Updated dependencies [a124406]
  - @primandproper/observability@0.1.0

## 0.1.0

### Minor Changes

- db7c3ec: add the `salsa20` encryptor, porting the Salsa20 provider from `platform-go/cryptography`.
  `Salsa20Encryptor` implements the existing `Encryptor` interface behind `@noble/ciphers` (audited,
  isomorphic — no Node built-ins), so it works identically on server and browser and keeps call-site
  code portable. A fresh random 8-byte nonce is generated per message and prepended to the ciphertext,
  matching the Go framing; keystream output is byte-for-byte identical to Go's
  `golang.org/x/crypto/salsa20`, so ciphertext cross-decrypts between the two platforms. Selectable via
  `provideEncryption({ provider: "salsa20", key })` (requires a base64 256-bit key). Note Salsa20 is a
  raw stream cipher and is **not** authenticated — prefer `aes-gcm` unless you need Salsa20 for Go
  interop.

  The non-cryptographic checksums from Go's `hashing` (Adler-32, CRC-64/ISO, FNV-1a-128) were
  intentionally **not** ported: no maintained isomorphic library covers them (CRC-64 has none at all),
  and hand-rolling checksum/crypto code was declined. Cryptographic hashing parity (SHA-256/384/512)
  is already provided by `SubtleHasher` over WebCrypto.
