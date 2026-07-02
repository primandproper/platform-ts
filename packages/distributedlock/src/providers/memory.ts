import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type { AcquireOptions, DistributedLock, Lock } from "../distributedlock.js";

const o11yName = "distributedlock";

/** Injectable clock + observability. `now` is overridable for deterministic tests. */
export interface MemoryDistributedLockDeps extends ObservabilityDeps {
  now?: () => number;
}

export interface MemoryDistributedLockOptions {
  /** Lease duration when {@link AcquireOptions.ttlMs} is omitted, in milliseconds. */
  defaultTtlMs?: number;
}

interface Lease {
  token: number;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 30_000;

/**
 * A correct in-process distributed lock: a {@link Map} of key to its current lease. A key may
 * be acquired iff it is free or its lease has expired against the injected clock. Each grant
 * stamps a unique token, so a {@link Lock} only frees the lease it still owns — a holder that
 * lost its lease (expired, then re-acquired by another caller) cannot release or refresh the
 * new holder's lock. Single-process mutual exclusion only; not cross-process.
 */
export class MemoryDistributedLock implements DistributedLock {
  readonly #defaultTtlMs: number;
  readonly #now: () => number;
  readonly #observer: Observer;
  readonly #logger: Logger;
  readonly #leases = new Map<string, Lease>();

  #nextToken = 1;

  constructor(
    options: MemoryDistributedLockOptions = {},
    deps: MemoryDistributedLockDeps = {},
  ) {
    this.#defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.#now = deps.now ?? (() => Date.now());
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  acquire(key: string, opts: AcquireOptions = {}): Promise<Lock | undefined> {
    const existing = this.#leases.get(key);
    if (existing !== undefined && existing.expiresAt > this.#now()) {
      this.#logger.debug("lock is already held");
      return Promise.resolve(undefined);
    }

    const ttlMs = opts.ttlMs ?? this.#defaultTtlMs;
    const token = this.#nextToken++;
    this.#leases.set(key, { token, expiresAt: this.#now() + ttlMs });
    return Promise.resolve(this.#makeLock(key, token, ttlMs));
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  #owns(key: string, token: number): boolean {
    const lease = this.#leases.get(key);
    return lease?.token === token && lease.expiresAt > this.#now();
  }

  #makeLock(key: string, token: number, ttlMs: number): Lock {
    const release = (): Promise<void> => {
      if (this.#owns(key, token)) {
        this.#leases.delete(key);
      } else {
        this.#logger.debug("release ignored: lease no longer owned");
      }
      return Promise.resolve();
    };

    const refresh = (newTtlMs?: number): Promise<void> => {
      const lease = this.#leases.get(key);
      if (lease?.token === token) {
        lease.expiresAt = this.#now() + (newTtlMs ?? ttlMs);
      } else {
        this.#logger.debug("refresh ignored: lease no longer owned");
      }
      return Promise.resolve();
    };

    return { key, release, refresh };
  }
}
