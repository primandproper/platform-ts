import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type { PasswordHasher } from "../password.js";

const o11yName = "authentication";

export interface ScryptHasherOptions {
  /** CPU/memory cost factor `N`; must be a power of two. */
  cost?: number;
  /** Block size `r`. */
  blockSize?: number;
  /** Parallelization factor `p`. */
  parallelization?: number;
  /** Length of the derived key in bytes. */
  keyLength?: number;
  /** Length of the random salt in bytes. */
  saltLength?: number;
}

const PREFIX = "scrypt";

function deriveKey(
  password: string,
  salt: Buffer,
  cost: number,
  blockSize: number,
  parallelization: number,
  keyLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keyLength,
      { N: cost, r: blockSize, p: parallelization, maxmem: 256 * cost * blockSize },
      (err, derivedKey) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}

/**
 * Hashes passwords with `node:crypto`'s scrypt. Each hash carries its own random salt and its
 * cost parameters, encoded as `scrypt$N=...,r=...,p=...$<saltB64>$<hashB64>`, so {@link verify}
 * parses the parameters back out and stays valid even after the defaults change.
 *
 * argon2id is the intended stronger future provider, but it needs a native dependency
 * (`node:crypto` exposes no argon2), so it is deliberately not implemented here.
 */
export class ScryptHasher implements PasswordHasher {
  readonly #cost: number;
  readonly #blockSize: number;
  readonly #parallelization: number;
  readonly #keyLength: number;
  readonly #saltLength: number;
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(options: ScryptHasherOptions = {}, deps: ObservabilityDeps = {}) {
    this.#cost = options.cost ?? 16384;
    this.#blockSize = options.blockSize ?? 8;
    this.#parallelization = options.parallelization ?? 1;
    this.#keyLength = options.keyLength ?? 64;
    this.#saltLength = options.saltLength ?? 16;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  async hash(password: string): Promise<string> {
    const salt = randomBytes(this.#saltLength);
    const key = await deriveKey(
      password,
      salt,
      this.#cost,
      this.#blockSize,
      this.#parallelization,
      this.#keyLength,
    );
    const params = `N=${String(this.#cost)},r=${String(this.#blockSize)},p=${String(this.#parallelization)}`;
    return `${PREFIX}$${params}$${salt.toString("base64")}$${key.toString("base64")}`;
  }

  async verify(password: string, encoded: string): Promise<boolean> {
    const parsed = parseEncoded(encoded);
    if (parsed === undefined) {
      this.#logger.debug("malformed encoded password hash");
      return false;
    }
    try {
      const key = await deriveKey(
        password,
        parsed.salt,
        parsed.cost,
        parsed.blockSize,
        parsed.parallelization,
        parsed.hash.length,
      );
      return key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash);
    } catch (err) {
      this.#logger.error("verifying password hash", err);
      return false;
    }
  }
}

interface ParsedHash {
  cost: number;
  blockSize: number;
  parallelization: number;
  salt: Buffer;
  hash: Buffer;
}

function parseEncoded(encoded: string): ParsedHash | undefined {
  const parts = encoded.split("$");
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    return undefined;
  }
  const [, rawParams, rawSalt, rawHash] = parts;

  const params = new Map<string, number>();
  for (const pair of (rawParams ?? "").split(",")) {
    const [name, value] = pair.split("=");
    const parsed = Number(value);
    if (name === undefined || value === undefined || !Number.isInteger(parsed)) {
      return undefined;
    }
    params.set(name, parsed);
  }

  const cost = params.get("N");
  const blockSize = params.get("r");
  const parallelization = params.get("p");
  if (cost === undefined || blockSize === undefined || parallelization === undefined) {
    return undefined;
  }

  const salt = Buffer.from(rawSalt ?? "", "base64");
  const hash = Buffer.from(rawHash ?? "", "base64");
  if (salt.length === 0 || hash.length === 0) {
    return undefined;
  }

  return { cost, blockSize, parallelization, salt, hash };
}
