import type { ProfilingConfig } from "../config.js";
import { ensureLogger, type Logger } from "../logger.js";
import type { ObservabilityDeps } from "../observability.js";
import type { Profiler } from "../profiling.js";

/**
 * Server-side profiler scaffold. It does not pull in a native profiling dependency
 * (`@pyroscope/nodejs` / `pprof` ship prebuilt N-API binaries that break across Node/ABI
 * versions and CI environments), so out of the box this is a logged noop. That keeps the
 * package install-clean while leaving an obvious, single seam for a caller to drop in real
 * profiling.
 *
 * To make it real, install `@pyroscope/nodejs` in your app and wire it in the marked spots:
 *
 * ```ts
 * import Pyroscope from "@pyroscope/nodejs";
 *
 * // in start():
 * Pyroscope.init({ serverAddress: this.#config.serverUrl, appName: this.#config.name });
 * Pyroscope.start();
 *
 * // in stop():
 * await Pyroscope.stop();
 * ```
 */
export class PyroscopeProfiler implements Profiler {
  readonly #config: ProfilingConfig;
  readonly #logger: Logger;
  #running = false;

  constructor(config: ProfilingConfig, deps: ObservabilityDeps = {}) {
    this.#config = config;
    this.#logger = ensureLogger(deps.logger).child("profiling");
  }

  start(): Promise<void> {
    if (this.#running) {
      return Promise.resolve();
    }
    this.#running = true;
    // Wire @pyroscope/nodejs here (see class doc). Until then this is a logged noop.
    this.#logger.warn(
      `profiling provider 'pyroscope' selected for '${this.#config.name}' but no profiler is wired; running as noop`,
    );
    return Promise.resolve();
  }

  stop(): Promise<void> {
    if (!this.#running) {
      return Promise.resolve();
    }
    this.#running = false;
    // Flush/stop the real profiler here.
    return Promise.resolve();
  }
}
