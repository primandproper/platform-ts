---
"@primandproper/cryptography": minor
---

Add a required `readonly authenticated: boolean` member to the `Encryptor` interface. Breaking for external `Encryptor` implementers. AES-GCM now validates key length at construction.
