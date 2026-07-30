import type { ObservabilityDeps } from "@primandproper/observability";

import {
  BrowserEventCaptureConfigSchema,
  type BrowserEventCaptureConfigInput,
} from "./config.js";
import { BeaconSink } from "./providers/beacon.browser.js";
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
export { BeaconSink } from "./providers/beacon.browser.js";

/**
 * Browser sink factory: validates config and returns the matching provider. Supports `noop`
 * (the default — capture wired but disabled), `memory`, and `beacon` (batched `fetch` POSTs to
 * a collection endpoint). Same signature as the Node factory, so call-site code is identical
 * across environments; only the durable provider differs.
 */
export function provideCaptureSink(
  config?: BrowserEventCaptureConfigInput,
  deps?: ObservabilityDeps,
): Sink {
  const cfg = BrowserEventCaptureConfigSchema.parse(config ?? {});
  switch (cfg.provider) {
    case "noop":
      return new NoopSink();
    case "memory":
      return new InMemorySink();
    case "beacon":
      // Presence guaranteed by the schema's superRefine; re-guarded for the type system.
      if (!cfg.beacon) {
        throw new Error("beacon config is required when provider is 'beacon'");
      }
      return new BeaconSink(cfg.beacon, deps);
  }
}

/**
 * Builds a {@link Recorder} over the configured sink. The event type is the caller's; `hooks`
 * (transform, observe, onFlush, overflow) infer from it, so no type argument is needed beyond
 * the event itself.
 *
 * The caller owns the recorder's lifecycle. In a browser that means closing it from a
 * `pagehide`/`visibilitychange` handler — the tail is only as durable as the last send the
 * browser lets through.
 */
export function provideEventRecorder<E>(
  config?: BrowserEventCaptureConfigInput,
  deps?: ObservabilityDeps,
  hooks: RecorderHooks<E> = {},
): Recorder<E> {
  const cfg = BrowserEventCaptureConfigSchema.parse(config ?? {});
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
