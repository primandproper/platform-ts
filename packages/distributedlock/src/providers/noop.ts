import type { DistributedLock, Lock } from "../distributedlock.js";

/**
 * A {@link DistributedLock} that grants every acquisition immediately and never blocks;
 * release and refresh are no-ops. Useful for single-instance deployments and tests where
 * mutual exclusion is unnecessary. Provides no actual exclusion — do not rely on it for safety.
 */
export class NoopDistributedLock implements DistributedLock {
  acquire(key: string): Promise<Lock | undefined> {
    return Promise.resolve({
      key,
      release: () => Promise.resolve(true),
      refresh: () => Promise.resolve(true),
    });
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
