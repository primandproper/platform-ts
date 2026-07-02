import { ensureLogger, type Logger } from "../logger.js";
import type { ObservabilityDeps } from "../observability.js";
import type { Profiler } from "../profiling.js";

/**
 * Browser profiler: always a noop. Continuous profiling samples a long-lived server process
 * and ships pprof profiles to a backend; the browser has no equivalent, and shipping per-user
 * profiles would be a privacy and bandwidth problem. The browser story is deliberately thin
 * so the same `provideProfiler` call site stays portable across environments — it accepts the
 * same deps as the Node provider and simply has nothing to do with them beyond a debug line.
 */
export class BrowserProfiler implements Profiler {
  readonly #logger: Logger;

  constructor(deps: ObservabilityDeps = {}) {
    this.#logger = ensureLogger(deps.logger).child("profiling");
  }

  start(): Promise<void> {
    this.#logger.debug("browser profiling is a noop");
    return Promise.resolve();
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}
