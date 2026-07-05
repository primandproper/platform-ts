import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

import {
  makeMetrics,
  makeObserver,
  type Metrics,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import { InvalidScryptCostError, PasswordHashError } from "../errors.js";
import type { PasswordHasher } from "../password.js";

type Counter = ReturnType<Metrics["counter"]>;

const o11yName = "authentication";

// Ceilings applied to cost parameters read out of an *untrusted* encoded hash during verify().
// Without them a hostile hash could name an enormous `N`/`r` and drive scrypt to allocate GBs
// (memory scales as ~128·N·r). These bound legitimate hashes comfortably (defaults are N=16384,
// r=8, p=1) while rejecting adversarial ones as malformed.
const MAX_COST = 1 << 20; // N ceiling (1,048,576)
const MAX_BLOCK_SIZE = 32; // r ceiling
const MAX_PARALLELIZATION = 16; // p ceiling

/** True when `n` is a power of two greater than one — the requirement scrypt places on `N`. */
function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;
}

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
  readonly #verifications: Counter;

  constructor(options: ScryptHasherOptions = {}, deps: ObservabilityDeps = {}) {
    this.#cost = options.cost ?? 16384;
    if (!isPowerOfTwo(this.#cost)) {
      throw new InvalidScryptCostError(this.#cost);
    }
    this.#blockSize = options.blockSize ?? 8;
    this.#parallelization = options.parallelization ?? 1;
    this.#keyLength = options.keyLength ?? 64;
    this.#saltLength = options.saltLength ?? 16;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#verifications = makeMetrics(o11yName, deps.metrics).counter(
      "authentication.password.verifications",
      { description: "Password verification attempts, by outcome." },
    );
  }

  async hash(password: string): Promise<string> {
    try {
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
    } catch (err) {
      throw new PasswordHashError(err);
    }
  }

  async verify(password: string, encoded: string): Promise<boolean> {
    return this.#observer.run("verify", async (op) => {
      const parsed = parseEncoded(encoded);
      if (parsed === undefined) {
        this.#verifications.add(1, { outcome: "failure" });
        op.logger().debug("malformed encoded password hash");
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
        const matched =
          key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash);
        const outcome = matched ? "success" : "failure";
        this.#verifications.add(1, { outcome });
        op.logger().debug(`password verification ${outcome}`);
        return matched;
      } catch (err) {
        this.#verifications.add(1, { outcome: "failure" });
        op.acknowledge(err, "verifying password hash");
        return false;
      }
    });
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
  // Reject cost parameters outside sane bounds so a hostile hash can't drive scrypt to allocate
  // GBs. An out-of-range parameter is treated as a malformed hash (verify → false), never a throw.
  if (
    !isPowerOfTwo(cost) ||
    cost > MAX_COST ||
    blockSize < 1 ||
    blockSize > MAX_BLOCK_SIZE ||
    parallelization < 1 ||
    parallelization > MAX_PARALLELIZATION
  ) {
    return undefined;
  }

  const salt = Buffer.from(rawSalt ?? "", "base64");
  const hash = Buffer.from(rawHash ?? "", "base64");
  if (salt.length === 0 || hash.length === 0) {
    return undefined;
  }

  return { cost, blockSize, parallelization, salt, hash };
}
