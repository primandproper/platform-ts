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
import type { Profiler } from "./profiling.js";
import { consoleLogger } from "./providers/console.browser.js";
import { BrowserProfiler } from "./providers/profiling.browser.js";

/** Browser default: validates config and returns a console-backed logger. */
export function provideLogger(config?: LoggingConfigInput): Logger {
  return consoleLogger(LoggingConfigSchema.parse(config ?? {}));
}

/**
 * Browser profiler factory. Same signature as the Node factory so call-site code is portable,
 * but the browser story is thin: every provider resolves to a noop (see `BrowserProfiler`).
 * Config is still validated so a mistyped value fails the same way it would on Node.
 */
export function provideProfiler(
  config?: ProfilingConfigInput,
  deps?: ObservabilityDeps,
): Profiler {
  ProfilingConfigSchema.parse(config ?? {});
  return new BrowserProfiler(deps);
}
