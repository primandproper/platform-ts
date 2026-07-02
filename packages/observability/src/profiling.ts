/**
 * Continuous-profiling contract. Continuous profiling is inherently a server-only concern —
 * it samples CPU/heap/wallclock of a long-lived process and ships pprof profiles to a backend
 * like Pyroscope. The browser has no equivalent (and shipping per-user profiles would be a
 * privacy and bandwidth problem), so the browser provider is a noop by design — see
 * `providers/profiling.browser.ts`.
 *
 * The interface is intentionally tiny: a profiler is started once near process boot and
 * stopped on graceful shutdown. Most call sites only ever touch `start`.
 */
export interface Profiler {
  /** Begins sampling. Idempotent: a second call while running is a no-op. */
  start(): Promise<void>;
  /** Stops sampling and flushes any pending profiles. Idempotent. */
  stop(): Promise<void>;
}

/** A profiler that does nothing. Shared singleton; safe everywhere. */
export class NoopProfiler implements Profiler {
  start(): Promise<void> {
    return Promise.resolve();
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}

export const noopProfiler: Profiler = new NoopProfiler();
