import type { EventStream, StreamState, Unsubscribe } from "../eventstream.js";

const noop: Unsubscribe = () => {
  /* nothing subscribed */
};

/**
 * Universal event stream that never connects and never delivers anything. Used for the
 * `noop` (disabled) provider and as an inert default. `connect()` is a noop, so `state`
 * stays `closed`.
 */
export class NoopEventStream implements EventStream {
  readonly state: StreamState = "closed";

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
