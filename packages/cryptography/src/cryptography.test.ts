import { describe, expect, it } from "vitest";

import { base64ToBytes, bytesToBase64 } from "./base64.js";
import type { Encryptor } from "./encryption.js";
import { AesGcmEncryptor } from "./providers/aes-gcm.js";
import { PassthroughEncryptor } from "./providers/passthrough.js";
import { Salsa20Encryptor } from "./providers/salsa20.js";
import { SubtleHasher } from "./providers/subtle-hasher.js";

const encoder = new TextEncoder();

/** A fixed, valid 256-bit AES key (all zero bytes), base64-encoded. */
const TEST_KEY = bytesToBase64(new Uint8Array(32));

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("base64 helpers", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 128, 64]);
    expect(base64ToBytes(bytesToBase64(bytes))).toStrictEqual(bytes);
  });

  it("round-trips a payload larger than the chunk size (PERF-4)", () => {
    // Exceeds the 0x8000 fromCharCode chunk so the chunked path is exercised across boundaries.
    const bytes = new Uint8Array(0x8000 * 2 + 123);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = i % 256;
    }
    expect(base64ToBytes(bytesToBase64(bytes))).toStrictEqual(bytes);
  });
});

/**
 * Provider-agnostic round-trip suite: anything implementing {@link Encryptor} must return the
 * original plaintext through encrypt -> decrypt.
 */
function roundTripConformance(name: string, make: () => Encryptor): void {
  describe(name, () => {
    it("round-trips plaintext through encrypt -> decrypt", async () => {
      const enc = make();
      const plaintext = encoder.encode("attack at dawn");
      const decrypted = await enc.decrypt(await enc.encrypt(plaintext));
      expect(decrypted).toStrictEqual(plaintext);
    });

    it("round-trips empty plaintext", async () => {
      const enc = make();
      const decrypted = await enc.decrypt(await enc.encrypt(new Uint8Array()));
      expect(decrypted).toStrictEqual(new Uint8Array());
    });
  });
}

roundTripConformance("AesGcmEncryptor", () => new AesGcmEncryptor({ key: TEST_KEY }));
roundTripConformance("Salsa20Encryptor", () => new Salsa20Encryptor({ key: TEST_KEY }));
roundTripConformance("PassthroughEncryptor", () => new PassthroughEncryptor());

describe("AesGcmEncryptor", () => {
  it("uses a fresh IV per call, so ciphertexts differ", async () => {
    const enc = new AesGcmEncryptor({ key: TEST_KEY });
    const plaintext = encoder.encode("same message");
    const a = await enc.encrypt(plaintext);
    const b = await enc.encrypt(plaintext);
    expect(toHex(a)).not.toBe(toHex(b));
    // ...yet both decrypt back to the original.
    expect(await enc.decrypt(a)).toStrictEqual(plaintext);
    expect(await enc.decrypt(b)).toStrictEqual(plaintext);
  });

  it("prepends a 12-byte IV to the ciphertext", async () => {
    const enc = new AesGcmEncryptor({ key: TEST_KEY });
    const plaintext = encoder.encode("hi");
    const ciphertext = await enc.encrypt(plaintext);
    // 12-byte IV + plaintext length + 16-byte GCM tag.
    expect(ciphertext.byteLength).toBe(12 + plaintext.byteLength + 16);
  });

  it("rejects tampered ciphertext", async () => {
    const enc = new AesGcmEncryptor({ key: TEST_KEY });
    const ciphertext = await enc.encrypt(encoder.encode("integrity matters"));
    const last = ciphertext.byteLength - 1;
    ciphertext[last] = (ciphertext[last] ?? 0) ^ 0xff;
    await expect(enc.decrypt(ciphertext)).rejects.toThrow(/tampered|invalid/);
  });

  it("rejects ciphertext too short to contain an IV", async () => {
    const enc = new AesGcmEncryptor({ key: TEST_KEY });
    await expect(enc.decrypt(new Uint8Array(8))).rejects.toThrow(/too short/);
  });

  it("rejects an invalid key length at construction (not first use)", () => {
    expect(() => new AesGcmEncryptor({ key: bytesToBase64(new Uint8Array(10)) })).toThrow(
      /key length/,
    );
  });

  it("rejects a key that is not valid base64 with a clear message", () => {
    expect(() => new AesGcmEncryptor({ key: "not valid base64!!!" })).toThrow(
      /not valid base64/,
    );
  });

  it("fails to decrypt with the wrong key", async () => {
    const a = new AesGcmEncryptor({ key: TEST_KEY });
    const b = new AesGcmEncryptor({ key: bytesToBase64(new Uint8Array(32).fill(1)) });
    const ciphertext = await a.encrypt(encoder.encode("secret"));
    await expect(b.decrypt(ciphertext)).rejects.toThrow(/tampered|invalid/);
  });
});

describe("Salsa20Encryptor", () => {
  it("uses a fresh nonce per call, so ciphertexts differ", async () => {
    const enc = new Salsa20Encryptor({ key: TEST_KEY });
    const plaintext = encoder.encode("same message");
    const a = await enc.encrypt(plaintext);
    const b = await enc.encrypt(plaintext);
    expect(toHex(a)).not.toBe(toHex(b));
    expect(await enc.decrypt(a)).toStrictEqual(plaintext);
    expect(await enc.decrypt(b)).toStrictEqual(plaintext);
  });

  it("prepends an 8-byte nonce to the same-length keystream", async () => {
    const enc = new Salsa20Encryptor({ key: TEST_KEY });
    const plaintext = encoder.encode("stream cipher");
    const ciphertext = await enc.encrypt(plaintext);
    // 8-byte nonce + plaintext length (stream cipher, no tag).
    expect(ciphertext.byteLength).toBe(8 + plaintext.byteLength);
  });

  it("rejects ciphertext too short to contain a nonce", async () => {
    const enc = new Salsa20Encryptor({ key: TEST_KEY });
    await expect(enc.decrypt(new Uint8Array(4))).rejects.toThrow(/too short/);
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(
      () => new Salsa20Encryptor({ key: bytesToBase64(new Uint8Array(16)) }),
    ).toThrow(/key length/);
  });

  // CRYPT-1: the tamper-rejection promise is explicitly carved out for unauthenticated providers.
  it("declares itself unauthenticated and cannot detect tampering", async () => {
    const enc = new Salsa20Encryptor({ key: TEST_KEY });
    expect(enc.authenticated).toBe(false);

    const ciphertext = await enc.encrypt(encoder.encode("integrity absent"));
    const last = ciphertext.byteLength - 1;
    ciphertext[last] = (ciphertext[last] ?? 0) ^ 0xff;
    // A tampered ciphertext decrypts WITHOUT throwing — the documented carve-out, not a regression.
    await expect(enc.decrypt(ciphertext)).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe("Encryptor.authenticated carve-out (CRYPT-1)", () => {
  it("marks only AES-GCM as authenticated", () => {
    expect(new AesGcmEncryptor({ key: TEST_KEY }).authenticated).toBe(true);
    expect(new Salsa20Encryptor({ key: TEST_KEY }).authenticated).toBe(false);
    expect(new PassthroughEncryptor().authenticated).toBe(false);
  });
});

describe("SubtleHasher", () => {
  it("matches the known SHA-256 vector for 'abc'", async () => {
    const hasher = new SubtleHasher({ algorithm: "SHA-256" });
    const digest = await hasher.hash(encoder.encode("abc"));
    expect(toHex(digest)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches the known SHA-512 vector for 'abc'", async () => {
    const hasher = new SubtleHasher({ algorithm: "SHA-512" });
    const digest = await hasher.hash(encoder.encode("abc"));
    expect(toHex(digest)).toBe(
      "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a" +
        "2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
    );
  });

  it("is deterministic across calls", async () => {
    const hasher = new SubtleHasher({ algorithm: "SHA-256" });
    const data = encoder.encode("deterministic");
    expect(toHex(await hasher.hash(data))).toBe(toHex(await hasher.hash(data)));
  });

  it("verifies a matching digest and rejects a mismatched one", async () => {
    const hasher = new SubtleHasher({ algorithm: "SHA-256" });
    const data = encoder.encode("verify me");
    const digest = await hasher.hash(data);
    expect(await hasher.verify(data, digest)).toBe(true);
    expect(await hasher.verify(encoder.encode("other"), digest)).toBe(false);
  });

  it("rejects a digest of the wrong length without throwing", async () => {
    const hasher = new SubtleHasher({ algorithm: "SHA-256" });
    expect(await hasher.verify(encoder.encode("x"), new Uint8Array(3))).toBe(false);
  });

  it("exposes its configured algorithm", () => {
    expect(new SubtleHasher({ algorithm: "SHA-384" }).algorithm).toBe("SHA-384");
  });
});
