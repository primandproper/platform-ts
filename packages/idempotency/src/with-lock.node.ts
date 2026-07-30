import type { DistributedLock, Lock } from "@primandproper/distributedlock";

/** The outcome of {@link withLock}: contention is reported, not thrown. */
export type LockAttempt<R> =
  | { acquired: true; value: R }
  /** The key stayed held by someone else for the whole wait budget. */
  | { acquired: false };

/** Options for {@link withLock}. */
export interface WithLockOptions {
  /** Lease duration for the acquired lock, in milliseconds. */
  ttlMs?: number;
  /** How long to keep retrying a held key before giving up. `0` means a single attempt. */
  waitMs?: number;
  /** How long to wait between attempts. */
  pollMs?: number;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
  /** Injectable delay, for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Called when releasing throws. Releasing happens in a `finally`, so letting it propagate
   * would replace `fn`'s result — or `fn`'s own error — with a failure of the cleanup. The lease
   * expires on its own ttl regardless, so the failure is reported here and otherwise ignored.
   */
  onReleaseError?: (err: unknown) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` while holding `key`, releasing the lock afterwards even if `fn` throws.
 *
 * `DistributedLock.acquire` reports contention as `undefined` immediately rather than blocking,
 * so this retries until `waitMs` is exhausted before reporting `{ acquired: false }`. Contention
 * is a return value rather than an exception for the same reason the underlying `acquire` makes
 * it one: it is an expected outcome the caller must branch on, not a failure.
 *
 * The release is best-effort — a `false` from `release()` means the lease had already expired or
 * been taken over, which `fn` overrunning `ttlMs` would cause; keep `fn` short.
 */
export async function withLock<R>(
  lock: DistributedLock,
  key: string,
  fn: (held: Lock) => Promise<R> | R,
  options: WithLockOptions = {},
): Promise<LockAttempt<R>> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const waitMs = options.waitMs ?? 0;
  const pollMs = options.pollMs ?? 25;
  const deadline = now() + waitMs;

  for (;;) {
    const held = await lock.acquire(
      key,
      options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {},
    );
    if (held !== undefined) {
      try {
        return { acquired: true, value: await fn(held) };
      } finally {
        try {
          await held.release();
        } catch (err) {
          options.onReleaseError?.(err);
        }
      }
    }
    if (now() >= deadline) {
      return { acquired: false };
    }
    await sleep(pollMs);
  }
}
