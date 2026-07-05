import {
  type LogValues,
  type Logger,
  type MeterProvider,
} from "@primandproper/observability";
import { describe, expect, it } from "vitest";

import {
  InvalidScryptCostError,
  InvalidTOTPSecretError,
  InvalidTokenLengthError,
} from "./errors.js";
import { ScryptHasher } from "./providers/scrypt.js";
import { RandomTokenGenerator } from "./providers/tokens.js";
import { RFC6238TOTP } from "./providers/totp.js";

import { providePasswordHasher, provideTOTP, provideTokenGenerator } from "./index.js";

describe("ScryptHasher", () => {
  // Small parameters keep the suite fast; production defaults are far higher.
  const make = (): ScryptHasher =>
    new ScryptHasher({ cost: 1024, blockSize: 8, parallelization: 1, keyLength: 32 });

  it("verifies a password it hashed", async () => {
    const hasher = make();
    const encoded = await hasher.hash("correct horse battery staple");
    expect(await hasher.verify("correct horse battery staple", encoded)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hasher = make();
    const encoded = await hasher.hash("correct horse battery staple");
    expect(await hasher.verify("Tr0ub4dor&3", encoded)).toBe(false);
  });

  it("returns false for a malformed encoded string", async () => {
    const hasher = make();
    expect(await hasher.verify("anything", "not-a-real-hash")).toBe(false);
    expect(await hasher.verify("anything", "scrypt$bogus")).toBe(false);
    expect(await hasher.verify("anything", "")).toBe(false);
  });

  it("produces a distinct hash each time from a random salt", async () => {
    const hasher = make();
    const a = await hasher.hash("same password");
    const b = await hasher.hash("same password");
    expect(a).not.toBe(b);
    expect(await hasher.verify("same password", a)).toBe(true);
    expect(await hasher.verify("same password", b)).toBe(true);
  });

  it("is constructed by providePasswordHasher with the scrypt default", () => {
    expect(providePasswordHasher()).toBeInstanceOf(ScryptHasher);
  });

  it("rejects a non-power-of-two cost at construction", () => {
    expect(() => new ScryptHasher({ cost: 1000 })).toThrow(InvalidScryptCostError);
    expect(() => providePasswordHasher({ scrypt: { cost: 1000 } })).toThrow();
  });

  it("treats a hash with an out-of-range cost as malformed instead of allocating for it", async () => {
    const hasher = make();
    // N = 2^30 would drive scrypt to allocate gigabytes; verify must reject it fast, not attempt it.
    const salt = Buffer.from("salt").toString("base64");
    const key = Buffer.alloc(32, 1).toString("base64");
    const hostile = `scrypt$N=1073741824,r=8,p=1$${salt}$${key}`;
    expect(await hasher.verify("anything", hostile)).toBe(false);
  });
});

describe("RFC6238TOTP", () => {
  it("verifies a code at the same pinned time", () => {
    const totp = new RFC6238TOTP();
    const secret = totp.generateSecret();
    const atMs = 1_700_000_000_000;
    const code = totp.generate(secret, atMs);
    expect(totp.verify(secret, code, { atMs, window: 0 })).toBe(true);
  });

  it("rejects a code from one period at a far-future period", () => {
    const totp = new RFC6238TOTP();
    const secret = totp.generateSecret();
    const atMs = 1_700_000_000_000;
    const code = totp.generate(secret, atMs);
    expect(totp.verify(secret, code, { atMs: atMs + 3_600_000, window: 1 })).toBe(false);
  });

  it("accepts an adjacent step within the window", () => {
    const totp = new RFC6238TOTP();
    const secret = totp.generateSecret();
    const atMs = 1_700_000_000_000;
    const code = totp.generate(secret, atMs);
    // One period earlier; the default window of 1 should still accept it.
    expect(totp.verify(secret, code, { atMs: atMs - 30_000, window: 1 })).toBe(true);
  });

  it("matches the RFC 6238 SHA1 test vector", () => {
    const totp = new RFC6238TOTP({ algorithm: "SHA1", digits: 8, period: 30 });
    // RFC 6238 Appendix B seed: ASCII "12345678901234567890", base32-encoded.
    const secret = base32OfAscii("12345678901234567890");
    expect(totp.generate(secret, 59_000)).toBe("94287082");
  });

  it("builds a key URI containing the issuer, account, and secret", () => {
    const totp = new RFC6238TOTP();
    const secret = totp.generateSecret();
    const uri = totp.keyUri(secret, "alice@example.com", "Prim & Proper");
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain(encodeURIComponent("Prim & Proper"));
    expect(uri).toContain(encodeURIComponent("alice@example.com"));
    expect(uri).toContain(`secret=${secret}`);
  });

  it("is constructed by provideTOTP", () => {
    expect(provideTOTP()).toBeInstanceOf(RFC6238TOTP);
  });

  it("throws a typed error on an invalid secret without leaking a secret character", () => {
    const totp = new RFC6238TOTP();
    const secret = "abc!def"; // '!' is not in the base32 alphabet
    let thrown: unknown;
    try {
      totp.generate(secret);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidTOTPSecretError);
    expect((thrown as Error).message).not.toContain("!");
  });
});

describe("RandomTokenGenerator", () => {
  it("generates distinct URL-safe tokens of the expected length", () => {
    const tokens = new RandomTokenGenerator();
    const a = tokens.generate();
    const b = tokens.generate();
    expect(a).not.toBe(b);
    // base64url of 32 bytes is 43 chars (no padding) and uses only the URL-safe alphabet.
    expect(a).toHaveLength(43);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it("honors a requested byte length", () => {
    const tokens = new RandomTokenGenerator();
    // base64url of 16 bytes is 22 chars.
    expect(tokens.generate(16)).toHaveLength(22);
  });

  it("is constructed by provideTokenGenerator", () => {
    expect(provideTokenGenerator().generate()).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it("rejects a non-positive byte length", () => {
    const tokens = new RandomTokenGenerator();
    expect(() => tokens.generate(0)).toThrow(InvalidTokenLengthError);
    expect(() => tokens.generate(-8)).toThrow(InvalidTokenLengthError);
    expect(() => tokens.generate(1.5)).toThrow(InvalidTokenLengthError);
  });
});

describe("ScryptHasher instrumentation", () => {
  const make = (deps: { logger: Logger; metrics: MeterProvider }): ScryptHasher =>
    new ScryptHasher(
      { cost: 1024, blockSize: 8, parallelization: 1, keyLength: 32 },
      deps,
    );

  it("counts a successful verification and logs it at debug", async () => {
    const { logger, debugs } = recordingLogger();
    const { provider, counts } = recordingMeter();
    const hasher = make({ logger, metrics: provider });

    const encoded = await hasher.hash("correct horse battery staple");
    expect(await hasher.verify("correct horse battery staple", encoded)).toBe(true);

    expect(counts["authentication.password.verifications:success"]).toBe(1);
    expect(counts["authentication.password.verifications:failure"] ?? 0).toBe(0);
    expect(debugs.some((d) => d.message === "password verification success")).toBe(true);
  });

  it("counts a failed verification, logs it at debug, and never logs the password", async () => {
    const { logger, debugs } = recordingLogger();
    const { provider, counts } = recordingMeter();
    const hasher = make({ logger, metrics: provider });

    const encoded = await hasher.hash("correct horse battery staple");
    expect(await hasher.verify("Tr0ub4dor&3", encoded)).toBe(false);

    expect(counts["authentication.password.verifications:failure"]).toBe(1);
    expect(counts["authentication.password.verifications:success"] ?? 0).toBe(0);
    expect(debugs.some((d) => d.message === "password verification failure")).toBe(true);
    expect(loggedText(debugs)).not.toContain("Tr0ub4dor&3");
    expect(loggedText(debugs)).not.toContain(encoded);
  });
});

describe("RFC6238TOTP instrumentation", () => {
  const atMs = 1_700_000_000_000;

  it("counts a successful verification and logs it at debug", () => {
    const { logger, debugs } = recordingLogger();
    const { provider, counts } = recordingMeter();
    const totp = new RFC6238TOTP({}, { logger, metrics: provider });

    const secret = totp.generateSecret();
    const code = totp.generate(secret, atMs);
    expect(totp.verify(secret, code, { atMs, window: 0 })).toBe(true);

    expect(counts["authentication.totp.verifications:success"]).toBe(1);
    expect(counts["authentication.totp.verifications:failure"] ?? 0).toBe(0);
    expect(debugs.some((d) => d.message === "TOTP verification success")).toBe(true);
  });

  it("counts a failed verification, logs it at debug, and never logs the secret or code", () => {
    const { logger, debugs } = recordingLogger();
    const { provider, counts } = recordingMeter();
    const totp = new RFC6238TOTP({}, { logger, metrics: provider });

    const secret = totp.generateSecret();
    const code = totp.generate(secret, atMs);
    expect(totp.verify(secret, "000000", { atMs, window: 0 })).toBe(false);

    expect(counts["authentication.totp.verifications:failure"]).toBe(1);
    expect(counts["authentication.totp.verifications:success"] ?? 0).toBe(0);
    expect(debugs.some((d) => d.message === "TOTP verification failure")).toBe(true);
    expect(loggedText(debugs)).not.toContain(secret);
    expect(loggedText(debugs)).not.toContain(code);
  });
});

interface DebugLine {
  message: string;
  values: LogValues;
}

/** A logger that records debug lines with every value `with`/`child`/`withSpan` has accumulated. */
function recordingLogger(): { logger: Logger; debugs: DebugLine[] } {
  const debugs: DebugLine[] = [];
  const make = (bound: LogValues): Logger => ({
    debug: (message, values) => {
      debugs.push({ message, values: { ...bound, ...values } });
    },
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    with: (values) => make({ ...bound, ...values }),
    child: () => make(bound),
    withSpan: () => make(bound),
  });
  return { logger: make({}), debugs };
}

/** Every debug line flattened to text, so a test can assert a secret never appears in any of them. */
function loggedText(debugs: DebugLine[]): string {
  return debugs.map((d) => `${d.message} ${JSON.stringify(d.values)}`).join("\n");
}

/** A meter provider that tallies counter `add`s by `${instrument}:${outcome}`. */
function recordingMeter(): { provider: MeterProvider; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  const counter = (name: string) => ({
    add: (value: number, attributes?: { outcome?: string }) => {
      const key = `${name}:${attributes?.outcome ?? ""}`;
      counts[key] = (counts[key] ?? 0) + value;
    },
  });
  const meter = {
    createCounter: (name: string) => counter(name),
    createUpDownCounter: (name: string) => counter(name),
    createHistogram: () => ({ record: () => undefined }),
    createGauge: () => ({ record: () => undefined }),
  };
  return {
    provider: { getMeter: () => meter } as unknown as MeterProvider,
    counts,
  };
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Test-only base32 encoder for the RFC 6238 ASCII seed. */
function base32OfAscii(ascii: string): string {
  const bytes = Buffer.from(ascii, "ascii");
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET.charAt((value << (5 - bits)) & 31);
  }
  return out;
}
