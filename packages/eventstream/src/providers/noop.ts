import { makeObserver, type ObservabilityDeps } from "@primandproper/observability";

import type { EventStream, StreamState, Unsubscribe } from "../eventstream.js";

const o11yName = "eventstream";

const noop: Unsubscribe = () => {
  /* nothing subscribed */
};

/**
 * Universal event stream that never connects and never delivers anything. Used for the
 * `noop` (disabled) provider and as an inert default. `connect()` is a noop, so `state`
 * stays `closed`.
 *
 * Because it silently delivers nothing, it warns once on construction — reaching this by
 * default (the config's default transport is `noop`) usually means a transport/url was never
 * configured, and a stream that quietly emits nothing is otherwise very hard to notice.
 */
export class NoopEventStream implements EventStream {
  readonly state: StreamState = "closed";

  constructor(deps: ObservabilityDeps = {}) {
    (deps.observer ?? makeObserver(o11yName, deps))
      .logger()
      .warn(
        "eventstream: noop transport is inert — it never connects or delivers events",
      );
  }

  connect(): void {}

  onMessage(): Unsubscribe {
    return noop;
  }

  on(): Unsubscribe {
    return noop;
  }

  onOpen(): Unsubscribe {
    return noop;
  }

  onError(): Unsubscribe {
    return noop;
  }

  onClose(): Unsubscribe {
    return noop;
  }

  close(): void {}
}
