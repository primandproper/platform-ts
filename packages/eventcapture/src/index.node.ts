import type { ObservabilityDeps } from "@primandproper/observability";

import {
  NodeEventCaptureConfigSchema,
  type NodeEventCaptureConfigInput,
} from "./config.js";
import { JsonlSink } from "./providers/jsonl.node.js";
import { InMemorySink } from "./providers/memory.js";
import { NoopSink } from "./providers/noop.js";
import { Recorder, type RecorderHooks } from "./recorder.js";
import type { Sink } from "./sink.js";

export * from "./aggregator.js";
export * from "./config.js";
export * from "./recorder.js";
export * from "./ring-buffer.js";
export * from "./sink.js";
export { InMemorySink } from "./providers/memory.js";
export { NoopSink } from "./providers/noop.js";
export { JsonlSink, type JsonlSinkOptions } from "./providers/jsonl.node.js";

/**
 * Node sink factory: validates config and returns the matching provider. Supports `noop` (the
 * default — capture wired but disabled), `memory`, and `jsonl` (an append-only, size-rotated
 * newline-delimited JSON file). Same signature as the browser factory, so call-site code is
 * identical across environments; only the durable provider differs.
 */
export function provideCaptureSink(
  config?: NodeEventCaptureConfigInput,
  deps?: ObservabilityDeps,
): Sink {
  const cfg = NodeEventCaptureConfigSchema.parse(config ?? {});
  switch (cfg.provider) {
    case "noop":
      return new NoopSink();
    case "memory":
      return new InMemorySink();
    case "jsonl":
      // Presence guaranteed by the schema's superRefine; re-guarded for the type system.
      if (!cfg.jsonl) {
        throw new Error("jsonl config is required when provider is 'jsonl'");
      }
      return new JsonlSink(cfg.jsonl, deps);
  }
}

/**
 * Builds a {@link Recorder} over the configured sink — the analogue of the Go platform's
 * `ProvideEventRecorder`. The event type is the caller's; `hooks` (transform, observe, onFlush,
 * overflow) infer from it, so no type argument is needed beyond the event itself.
 *
 * The caller owns the recorder's lifecycle: `close()` it after whatever produces events has
 * stopped, so the tail is drained rather than lost.
 */
export function provideEventRecorder<E>(
  config?: NodeEventCaptureConfigInput,
  deps?: ObservabilityDeps,
  hooks: RecorderHooks<E> = {},
): Recorder<E> {
  const cfg = NodeEventCaptureConfigSchema.parse(config ?? {});
  return new Recorder<E>(
    provideCaptureSink(cfg, deps),
    {
      ...hooks,
      bufferSize: cfg.bufferSize,
      flushIntervalMs: cfg.flushIntervalMs,
      rawRecords: cfg.rawRecords,
    },
    deps,
  );
}
