import {
  makeObserver,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type { AcquireOptions, DistributedLock, Lock } from "../distributedlock.js";

import { lockInstruments, type LockInstruments } from "./support.js";

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
  readonly #instruments: LockInstruments;
  readonly #leases = new Map<string, Lease>();

  #nextToken = 1;

  constructor(
    options: MemoryDistributedLockOptions = {},
    deps: MemoryDistributedLockDeps = {},
  ) {
    this.#defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.#now = deps.now ?? (() => Date.now());
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#instruments = lockInstruments(o11yName, deps);
  }

  acquire(key: string, opts: AcquireOptions = {}): Promise<Lock | undefined> {
    return this.#observer.run("acquire", (op) => {
      op.set("key", key);
      // DL-2: opportunistically drop every lapsed lease so a key that was acquired once and then
      // abandoned (expired, never re-acquired) doesn't linger in the map forever. Cheap in-process
      // (the lock set is small) and safe — an expired lease is dead.
      const swept = this.#sweepExpired();
      if (swept > 0) op.set("leases.swept", swept);
      const existing = this.#leases.get(key);
      if (existing !== undefined && existing.expiresAt > this.#now()) {
        op.logger().debug("lock is already held");
        this.#instruments.contention.add(1, { operation: "acquire" });
        return undefined;
      }

      const ttlMs = opts.ttlMs ?? this.#defaultTtlMs;
      const token = this.#nextToken++;
      this.#leases.set(key, { token, expiresAt: this.#now() + ttlMs });
      return this.#makeLock(key, token, ttlMs);
    });
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  /** Drops every lease whose expiry has passed against the injected clock; returns how many. */
  #sweepExpired(): number {
    const now = this.#now();
    let swept = 0;
    for (const [key, lease] of this.#leases) {
      if (lease.expiresAt <= now) {
        this.#leases.delete(key);
        swept += 1;
      }
    }
    return swept;
  }

  #owns(key: string, token: number): boolean {
    const lease = this.#leases.get(key);
    return lease?.token === token && lease.expiresAt > this.#now();
  }

  #makeLock(key: string, token: number, ttlMs: number): Lock {
    const release = (): Promise<boolean> =>
      this.#observer.run("release", (op) => {
        op.set("key", key);
        if (this.#owns(key, token)) {
          this.#leases.delete(key);
          return true;
        }
        op.logger().debug("release ignored: lease no longer owned");
        this.#instruments.contention.add(1, { operation: "release" });
        return false;
      });

    const refresh = (newTtlMs?: number): Promise<boolean> =>
      this.#observer.run("refresh", (op) => {
        op.set("key", key);
        // Guard on #owns (token AND unexpired) so refresh cannot revive a lapsed lease, matching
        // the redis/postgres providers, whose stores drop expired leases on their own clocks.
        if (this.#owns(key, token)) {
          const lease = this.#leases.get(key);
          if (lease !== undefined) {
            lease.expiresAt = this.#now() + (newTtlMs ?? ttlMs);
          }
          return true;
        }
        op.logger().debug("refresh ignored: lease no longer owned");
        this.#instruments.contention.add(1, { operation: "refresh" });
        return false;
      });

    return { key, release, refresh };
  }
}
