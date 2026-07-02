import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type { TOTP } from "../totp.js";

const o11yName = "authentication";

export type TOTPAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface RFC6238TOTPOptions {
  /** HMAC algorithm. Authenticator apps almost universally expect SHA1. */
  algorithm?: TOTPAlgorithm;
  /** Number of digits in a generated code. */
  digits?: number;
  /** Length of a time step in seconds. */
  period?: number;
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Encodes bytes as RFC 4648 base32 without padding. */
function base32Encode(bytes: Buffer): string {
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

/** Decodes an RFC 4648 base32 string (padding and case insensitive). Throws on invalid input. */
function base32Decode(input: string): Buffer {
  const normalized = input.replace(/=+$/u, "").toUpperCase().replace(/\s/gu, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`invalid base32 character: ${char}`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function counterBuffer(counter: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  return buf;
}

/** Implements TOTP per RFC 6238 (HOTP/RFC 4226 truncation) using `node:crypto` HMAC. */
export class RFC6238TOTP implements TOTP {
  readonly #algorithm: TOTPAlgorithm;
  readonly #digits: number;
  readonly #period: number;
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(options: RFC6238TOTPOptions = {}, deps: ObservabilityDeps = {}) {
    this.#algorithm = options.algorithm ?? "SHA1";
    this.#digits = options.digits ?? 6;
    this.#period = options.period ?? 30;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  generateSecret(bytes = 20): string {
    return base32Encode(randomBytes(bytes));
  }

  keyUri(secret: string, accountName: string, issuer: string): string {
    const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
    const params = new URLSearchParams({
      secret,
      issuer,
      algorithm: this.#algorithm,
      digits: String(this.#digits),
      period: String(this.#period),
    });
    return `otpauth://totp/${label}?${params.toString()}`;
  }

  generate(secret: string, atMs: number = Date.now()): string {
    return this.#codeForCounter(secret, this.#counterAt(atMs));
  }

  verify(
    secret: string,
    code: string,
    opts: { window?: number; atMs?: number } = {},
  ): boolean {
    const window = opts.window ?? 1;
    const counter = this.#counterAt(opts.atMs ?? Date.now());
    try {
      for (let offset = -window; offset <= window; offset++) {
        const candidate = this.#codeForCounter(secret, counter + offset);
        if (constantTimeEqual(candidate, code)) {
          return true;
        }
      }
    } catch (err) {
      this.#logger.error("verifying TOTP code", err);
      return false;
    }
    return false;
  }

  #counterAt(atMs: number): number {
    return Math.floor(atMs / 1000 / this.#period);
  }

  #codeForCounter(secret: string, counter: number): string {
    const key = base32Decode(secret);
    const digest = createHmac(this.#algorithm, key)
      .update(counterBuffer(counter))
      .digest();
    const offset = digest.readUInt8(digest.length - 1) & 0x0f;
    const binary = digest.readUInt32BE(offset) & 0x7fffffff;
    return (binary % 10 ** this.#digits).toString().padStart(this.#digits, "0");
  }
}

/** Length-safe constant-time string comparison via {@link timingSafeEqual}. */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
