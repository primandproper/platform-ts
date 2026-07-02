export * from "./logger.js";
export * from "./observability.js";
export * from "./config.js";
export * from "./metrics.js";
export * from "./tracing.js";
export * from "./profiling.js";
export * from "./operation.js";
export * from "./observer.js";
export * from "./recording.js";

import {
  LoggingConfigSchema,
  ProfilingConfigSchema,
  type LoggingConfigInput,
  type ProfilingConfigInput,
} from "./config.js";
import type { Logger } from "./logger.js";
import type { ObservabilityDeps } from "./observability.js";
import { noopProfiler, type Profiler } from "./profiling.js";
import { pinoLogger } from "./providers/pino.node.js";
import { PyroscopeProfiler } from "./providers/profiling.node.js";

/** Node default: validates config and returns a pino-backed logger. */
export function provideLogger(config?: LoggingConfigInput): Logger {
  return pinoLogger(LoggingConfigSchema.parse(config ?? {}));
}

/**
 * Node default profiler factory. `noop` (default) discards everything; `pyroscope` returns
 * the server-side scaffold described in `providers/profiling.node.ts`. Same signature as the
 * browser factory so call-site code is portable — the browser resolves any provider to noop.
 */
export function provideProfiler(
  config?: ProfilingConfigInput,
  deps?: ObservabilityDeps,
): Profiler {
  const cfg = ProfilingConfigSchema.parse(config ?? {});
  switch (cfg.provider) {
    case "noop":
      return noopProfiler;
    case "pyroscope":
      return new PyroscopeProfiler(cfg, deps);
  }
}
