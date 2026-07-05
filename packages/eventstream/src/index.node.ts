import type { ObservabilityDeps } from "@primandproper/observability";

import { EventStreamConfigSchema, type EventStreamConfigInput } from "./config.js";
import type { EventStream } from "./eventstream.js";
import { NoopEventStream } from "./providers/noop.js";
import { SseEventStream } from "./providers/sse.js";
import { WebSocketEventStream } from "./providers/websocket.js";

export * from "./eventstream.js";
export * from "./config.js";
export { NoopEventStream } from "./providers/noop.js";
export { SseEventStream, type SseEventStreamOptions } from "./providers/sse.js";
export {
  WebSocketEventStream,
  type WebSocketEventStreamOptions,
} from "./providers/websocket.js";
export type {
  EventSourceCtor,
  EventSourceLike,
  EventSourceMessage,
  WebSocketCloseEvent,
  WebSocketCtor,
  WebSocketLike,
  WebSocketMessage,
} from "./providers/transports.js";

/**
 * Node default factory: validates config and returns the matching transport. Mirrors the Go
 * platform's `Provide*`. Supports `noop` (default), `sse`, and `websocket`.
 *
 * The SSE/WebSocket transports default to `globalThis.EventSource`/`globalThis.WebSocket`,
 * which are stable on Node 22+. On Node < 22, construct {@link SseEventStream} or
 * {@link WebSocketEventStream} directly and inject a constructor via `eventSourceCtor` /
 * `webSocketCtor` (e.g. from `undici`, the `eventsource` package, or `ws`).
 */
export function provideEventStream(
  config?: EventStreamConfigInput,
  deps?: ObservabilityDeps,
): EventStream {
  const cfg = EventStreamConfigSchema.parse(config ?? {});
  switch (cfg.transport) {
    case "sse":
      // superRefine guarantees this, but narrow for the type checker.
      if (cfg.url === undefined) {
        throw new Error("url is required when transport is 'sse'");
      }
      return new SseEventStream({ url: cfg.url, events: cfg.events }, deps);
    case "websocket":
      if (cfg.url === undefined) {
        throw new Error("url is required when transport is 'websocket'");
      }
      return new WebSocketEventStream(
        cfg.protocols === undefined
          ? { url: cfg.url }
          : { url: cfg.url, protocols: cfg.protocols },
        deps,
      );
    case "noop":
      return new NoopEventStream(deps);
  }
}
