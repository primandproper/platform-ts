import type { Logger } from "@primandproper/observability";
import { describe, expect, it, vi } from "vitest";

import type { EventStream, StreamMessage } from "./eventstream.js";
import { NoopEventStream } from "./providers/noop.js";
import { SseEventStream } from "./providers/sse.js";
import type {
  EventSourceLike,
  EventSourceMessage,
  WebSocketCloseEvent,
  WebSocketLike,
  WebSocketMessage,
} from "./providers/transports.js";
import { WebSocketEventStream, type ReconnectOptions } from "./providers/websocket.js";

/**
 * Hand-written `EventSource` fake. Implements only the surface the SSE transport touches, and
 * exposes drivers (`emitOpen`/`emitMessage`/…) so tests can simulate the server. No real
 * network is opened.
 */
class FakeEventSource implements EventSourceLike {
  static last: FakeEventSource | undefined;

  onopen: ((this: EventSourceLike, ev: unknown) => void) | null = null;
  onmessage: ((this: EventSourceLike, ev: EventSourceMessage) => void) | null = null;
  onerror: ((this: EventSourceLike, ev: unknown) => void) | null = null;
  closed = false;
  readyState = 1; // OPEN by default; drivers set it before emitting an error
  readonly #listeners = new Map<string, (ev: EventSourceMessage) => void>();

  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }

  addEventListener(type: string, listener: (ev: EventSourceMessage) => void): void {
    this.#listeners.set(type, listener);
  }

  removeEventListener(type: string, listener: (ev: EventSourceMessage) => void): void {
    if (this.#listeners.get(type) === listener) {
      this.#listeners.delete(type);
    }
  }

  /** Number of currently-attached named-event listeners (test introspection). */
  get listenerCount(): number {
    return this.#listeners.size;
  }

  close(): void {
    this.closed = true;
  }

  emitOpen(): void {
    this.onopen?.call(this, {});
  }

  emitMessage(msg: EventSourceMessage): void {
    this.onmessage?.call(this, msg);
  }

  emitNamed(type: string, msg: EventSourceMessage): void {
    this.#listeners.get(type)?.(msg);
  }

  emitError(err: unknown, readyState = 1): void {
    this.readyState = readyState;
    this.onerror?.call(this, err);
  }
}

/** Hand-written `WebSocket` fake mirroring {@link FakeEventSource}. */
class FakeWebSocket implements WebSocketLike {
  static last: FakeWebSocket | undefined;

  onopen: ((this: WebSocketLike, ev: unknown) => void) | null = null;
  onmessage: ((this: WebSocketLike, ev: WebSocketMessage) => void) | null = null;
  onerror: ((this: WebSocketLike, ev: unknown) => void) | null = null;
  onclose: ((this: WebSocketLike, ev: WebSocketCloseEvent) => void) | null = null;
  closed = false;
  readonly sent: string[] = [];

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeWebSocket.last = this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  emitOpen(): void {
    this.onopen?.call(this, {});
  }

  emitMessage(data: unknown): void {
    this.onmessage?.call(this, { data });
  }

  emitError(err: unknown): void {
    this.onerror?.call(this, err);
  }

  emitClose(ev: WebSocketCloseEvent = {}): void {
    this.onclose?.call(this, ev);
  }
}

describe("SseEventStream", () => {
  function make(events: readonly string[] = []): {
    stream: SseEventStream;
    source: () => FakeEventSource;
  } {
    FakeEventSource.last = undefined;
    const stream = new SseEventStream({
      url: "https://example.test/sse",
      events,
      eventSourceCtor: FakeEventSource,
    });
    return {
      stream,
      source: () => {
        if (FakeEventSource.last === undefined) {
          throw new Error("EventSource not constructed");
        }
        return FakeEventSource.last;
      },
    };
  }

  it("starts closed before connect", () => {
    const { stream } = make();
    expect(stream.state).toBe("closed");
  });

  it("is connecting after connect and open after the transport opens", () => {
    const { stream, source } = make();
    const onOpen = vi.fn();
    stream.onOpen(onOpen);

    stream.connect();
    expect(stream.state).toBe("connecting");

    source().emitOpen();
    expect(stream.state).toBe("open");
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("dispatches default messages to onMessage", () => {
    const { stream, source } = make();
    const received: StreamMessage[] = [];
    stream.onMessage((m) => received.push(m));

    stream.connect();
    source().emitOpen();
    source().emitMessage({ data: "hello", lastEventId: "7" });

    expect(received).toStrictEqual([{ data: "hello", id: "7" }]);
  });

  it("routes named events to on(event) and onMessage", () => {
    const { stream, source } = make(["tick"]);
    const onTick = vi.fn();
    const onAny = vi.fn();
    stream.on("tick", onTick);
    stream.onMessage(onAny);

    stream.connect();
    source().emitOpen();
    source().emitNamed("tick", { data: "1" });

    expect(onTick).toHaveBeenCalledWith({ event: "tick", data: "1" });
    expect(onAny).toHaveBeenCalledWith({ event: "tick", data: "1" });
  });

  it("removes named-event listeners from the source on close (ES-5)", () => {
    const { stream, source } = make(["tick", "tock"]);
    stream.connect();
    source().emitOpen();
    expect(source().listenerCount).toBe(2);

    stream.close();
    // the source's named-event listeners must be detached, not left dangling.
    expect(source().listenerCount).toBe(0);
  });

  it("fires onError on a transport error", () => {
    const { stream, source } = make();
    const onError = vi.fn();
    stream.onError(onError);

    stream.connect();
    const boom = new Error("boom");
    source().emitError(boom);

    expect(onError).toHaveBeenCalledWith(boom);
  });

  // ES-2: readyState drives the state machine instead of lying "open" forever.
  it("reflects a reconnecting EventSource as connecting, not open", () => {
    const { stream, source } = make();
    stream.connect();
    source().emitOpen();
    expect(stream.state).toBe("open");

    source().emitError(new Error("dropped"), 0); // CONNECTING: EventSource is retrying
    expect(stream.state).toBe("connecting");

    source().emitOpen(); // reconnect succeeds
    expect(stream.state).toBe("open");
  });

  it("fires onClose and goes closed on a fatal (readyState CLOSED) error", () => {
    const { stream, source } = make();
    const onClose = vi.fn();
    stream.onClose(onClose);

    stream.connect();
    source().emitOpen();
    source().emitError(new Error("fatal"), 2); // CLOSED: EventSource gave up

    expect(stream.state).toBe("closed");
    expect(onClose).toHaveBeenCalledOnce();
    expect(source().closed).toBe(true);
  });

  it("close() tears down the source, fires onClose, and sets state", () => {
    const { stream, source } = make();
    const onClose = vi.fn();
    stream.onClose(onClose);

    stream.connect();
    source().emitOpen();
    stream.close();

    expect(stream.state).toBe("closed");
    expect(source().closed).toBe(true);
    expect(source().onmessage).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("delivers no messages after close", () => {
    const { stream, source } = make();
    const onAny = vi.fn();
    stream.onMessage(onAny);

    stream.connect();
    const src = source();
    src.emitOpen();
    stream.close();
    src.emitMessage({ data: "late" });

    expect(onAny).not.toHaveBeenCalled();
  });

  it("unsubscribes a handler", () => {
    const { stream, source } = make();
    const onAny = vi.fn();
    const off = stream.onMessage(onAny);

    stream.connect();
    source().emitOpen();
    off();
    source().emitMessage({ data: "x" });

    expect(onAny).not.toHaveBeenCalled();
  });

  // ES-4: one throwing subscriber must not starve the others.
  it("isolates a throwing subscriber from the rest", () => {
    const { stream, source } = make();
    const boom = vi.fn(() => {
      throw new Error("subscriber blew up");
    });
    const ok = vi.fn();
    stream.onMessage(boom);
    stream.onMessage(ok);

    stream.connect();
    source().emitOpen();
    expect(() => {
      source().emitMessage({ data: "x" });
    }).not.toThrow();

    expect(boom).toHaveBeenCalledOnce();
    expect(ok).toHaveBeenCalledWith({ data: "x" }); // reached despite boom throwing first
  });

  it("throws when no EventSource is available", () => {
    const g = globalThis as Record<string, unknown>;
    const original = g.EventSource;
    try {
      delete g.EventSource;
      expect(() => new SseEventStream({ url: "https://example.test/sse" })).toThrow(
        /EventSource/,
      );
    } finally {
      if (original !== undefined) {
        g.EventSource = original;
      }
    }
  });
});

describe("WebSocketEventStream", () => {
  function make(): {
    stream: WebSocketEventStream;
    socket: () => FakeWebSocket;
  } {
    FakeWebSocket.last = undefined;
    const stream = new WebSocketEventStream({
      url: "wss://example.test/ws",
      webSocketCtor: FakeWebSocket,
    });
    return {
      stream,
      socket: () => {
        if (FakeWebSocket.last === undefined) {
          throw new Error("WebSocket not constructed");
        }
        return FakeWebSocket.last;
      },
    };
  }

  it("opens and fires onOpen", () => {
    const { stream, socket } = make();
    const onOpen = vi.fn();
    stream.onOpen(onOpen);

    stream.connect();
    expect(stream.state).toBe("connecting");
    socket().emitOpen();

    expect(stream.state).toBe("open");
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("parses JSON frames into structured messages", () => {
    const { stream, socket } = make();
    const received: StreamMessage[] = [];
    stream.onMessage((m) => received.push(m));

    stream.connect();
    socket().emitOpen();
    socket().emitMessage(JSON.stringify({ event: "tick", data: "1", id: "9" }));

    expect(received).toStrictEqual([{ event: "tick", data: "1", id: "9" }]);
  });

  it("falls back to raw text for non-JSON frames", () => {
    const { stream, socket } = make();
    const received: StreamMessage[] = [];
    stream.onMessage((m) => received.push(m));

    stream.connect();
    socket().emitOpen();
    socket().emitMessage("plain text");

    expect(received).toStrictEqual([{ data: "plain text" }]);
  });

  it("routes parsed named events to on(event)", () => {
    const { stream, socket } = make();
    const onTick = vi.fn();
    stream.on("tick", onTick);

    stream.connect();
    socket().emitOpen();
    socket().emitMessage(JSON.stringify({ event: "tick", data: "go" }));

    expect(onTick).toHaveBeenCalledWith({ event: "tick", data: "go" });
  });

  it("fires onError for a non-text frame", () => {
    const { stream, socket } = make();
    const onError = vi.fn();
    stream.onError(onError);

    stream.connect();
    socket().emitOpen();
    socket().emitMessage(new ArrayBuffer(4));

    expect(onError).toHaveBeenCalledOnce();
  });

  it("fires onError on a transport error", () => {
    const { stream, socket } = make();
    const onError = vi.fn();
    stream.onError(onError);

    stream.connect();
    const boom = new Error("socket boom");
    socket().emitError(boom);

    expect(onError).toHaveBeenCalledWith(boom);
  });

  it("send() throws unless open and forwards once open", () => {
    const { stream, socket } = make();
    expect(() => {
      stream.send("nope");
    }).toThrow(/not open/);

    stream.connect();
    socket().emitOpen();
    stream.send("hi");

    expect(socket().sent).toStrictEqual(["hi"]);
  });

  it("close() tears down the socket, fires onClose, and sets state", () => {
    const { stream, socket } = make();
    const onClose = vi.fn();
    stream.onClose(onClose);

    stream.connect();
    socket().emitOpen();
    stream.close();

    expect(stream.state).toBe("closed");
    expect(socket().closed).toBe(true);
    expect(socket().onmessage).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("a peer-initiated close transitions to closed and fires onClose once", () => {
    const { stream, socket } = make();
    const onClose = vi.fn();
    stream.onClose(onClose);

    stream.connect();
    socket().emitOpen();
    socket().emitClose({ code: 1000, reason: "bye" });

    expect(stream.state).toBe("closed");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("throws when no WebSocket is available", () => {
    const g = globalThis as Record<string, unknown>;
    const original = g.WebSocket;
    try {
      delete g.WebSocket;
      expect(() => new WebSocketEventStream({ url: "wss://example.test/ws" })).toThrow(
        /WebSocket/,
      );
    } finally {
      if (original !== undefined) {
        g.WebSocket = original;
      }
    }
  });
});

// ES-1: an unclean drop must reconnect with backoff instead of ending the stream.
describe("WebSocketEventStream reconnection", () => {
  function make(reconnect: ReconnectOptions | false): {
    stream: WebSocketEventStream;
    socket: () => FakeWebSocket;
  } {
    FakeWebSocket.last = undefined;
    const stream = new WebSocketEventStream({
      url: "wss://example.test/ws",
      webSocketCtor: FakeWebSocket,
      reconnect,
    });
    return {
      stream,
      socket: () => {
        if (FakeWebSocket.last === undefined) {
          throw new Error("WebSocket not constructed");
        }
        return FakeWebSocket.last;
      },
    };
  }

  it("reconnects with backoff after an unclean drop", async () => {
    vi.useFakeTimers();
    try {
      const { stream, socket } = make({ baseDelayMs: 100, jitter: 0 });
      const onClose = vi.fn();
      stream.onClose(onClose);

      stream.connect();
      const first = socket();
      first.emitOpen();
      expect(stream.state).toBe("open");

      first.emitClose({ code: 1006 }); // abnormal closure -> transient
      expect(stream.state).toBe("connecting");
      expect(onClose).not.toHaveBeenCalled();
      expect(first.closed).toBe(true);

      await vi.advanceTimersByTimeAsync(100);
      const second = socket();
      expect(second).not.toBe(first); // a fresh socket was opened
      second.emitOpen();
      expect(stream.state).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reconnect on a clean close", async () => {
    vi.useFakeTimers();
    try {
      const { stream, socket } = make({ baseDelayMs: 100, jitter: 0 });
      const onClose = vi.fn();
      stream.onClose(onClose);

      stream.connect();
      const first = socket();
      first.emitOpen();
      first.emitClose({ code: 1000 }); // normal closure

      expect(stream.state).toBe("closed");
      expect(onClose).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(socket()).toBe(first); // no reconnect scheduled
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnect:false ends the stream on any drop", () => {
    const { stream, socket } = make(false);
    const onClose = vi.fn();
    stream.onClose(onClose);

    stream.connect();
    socket().emitOpen();
    socket().emitClose({ code: 1006 });

    expect(stream.state).toBe("closed");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("a user close() cancels a pending reconnect", async () => {
    vi.useFakeTimers();
    try {
      const { stream, socket } = make({ baseDelayMs: 100, jitter: 0 });
      stream.connect();
      const first = socket();
      first.emitOpen();
      first.emitClose({ code: 1006 });
      expect(stream.state).toBe("connecting");

      stream.close();
      expect(stream.state).toBe("closed");

      await vi.advanceTimersByTimeAsync(100);
      expect(socket()).toBe(first); // reconnect timer was cancelled; no new socket
    } finally {
      vi.useRealTimers();
    }
  });
});

// ES-3: a silent (half-open) connection must be detected via the heartbeat deadline.
describe("heartbeat liveness", () => {
  it("WebSocket reconnects when no frame arrives within the deadline", async () => {
    vi.useFakeTimers();
    try {
      FakeWebSocket.last = undefined;
      const stream = new WebSocketEventStream({
        url: "wss://example.test/ws",
        webSocketCtor: FakeWebSocket,
        heartbeatTimeoutMs: 1_000,
        reconnect: { baseDelayMs: 100, jitter: 0 },
      });
      const socket = (): FakeWebSocket => {
        if (FakeWebSocket.last === undefined) {
          throw new Error("WebSocket not constructed");
        }
        return FakeWebSocket.last;
      };

      stream.connect();
      const first = socket();
      first.emitOpen();

      await vi.advanceTimersByTimeAsync(1_000); // silence past the deadline
      expect(stream.state).toBe("connecting");
      expect(first.closed).toBe(true);

      await vi.advanceTimersByTimeAsync(100); // reconnect backoff
      expect(socket()).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("WebSocket keeps the connection alive while frames keep arriving", async () => {
    vi.useFakeTimers();
    try {
      FakeWebSocket.last = undefined;
      const stream = new WebSocketEventStream({
        url: "wss://example.test/ws",
        webSocketCtor: FakeWebSocket,
        heartbeatTimeoutMs: 1_000,
      });
      const socket = (): FakeWebSocket => {
        if (FakeWebSocket.last === undefined) {
          throw new Error("WebSocket not constructed");
        }
        return FakeWebSocket.last;
      };

      stream.connect();
      socket().emitOpen();

      await vi.advanceTimersByTimeAsync(600);
      socket().emitMessage(JSON.stringify({ data: "keepalive" })); // resets the deadline
      await vi.advanceTimersByTimeAsync(600); // only 600ms since the last message

      expect(stream.state).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });

  it("SSE reopens a fresh EventSource when the deadline lapses", async () => {
    vi.useFakeTimers();
    try {
      FakeEventSource.last = undefined;
      const stream = new SseEventStream({
        url: "https://example.test/sse",
        eventSourceCtor: FakeEventSource,
        heartbeatTimeoutMs: 1_000,
      });
      const source = (): FakeEventSource => {
        if (FakeEventSource.last === undefined) {
          throw new Error("EventSource not constructed");
        }
        return FakeEventSource.last;
      };

      stream.connect();
      const first = source();
      first.emitOpen();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(first.closed).toBe(true);
      expect(source()).not.toBe(first); // a fresh EventSource was opened
      expect(stream.state).toBe("connecting");

      source().emitOpen();
      expect(stream.state).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Provider-agnostic conformance over the lifecycle contract. Each entry drives its fake to
 * open, so the same assertions hold across both transports and the noop.
 */
function conformance(
  name: string,
  make: () => { stream: EventStream; open: () => void; connects: boolean },
): void {
  describe(`${name} conformance`, () => {
    it("reports open after connecting (or stays closed for noop)", () => {
      const { stream, open, connects } = make();
      const onOpen = vi.fn();
      stream.onOpen(onOpen);

      stream.connect();
      open();

      expect(stream.state).toBe(connects ? "open" : "closed");
    });

    it("ends closed after close()", () => {
      const { stream, open } = make();
      stream.connect();
      open();
      stream.close();
      expect(stream.state).toBe("closed");
    });
  });
}

conformance("SseEventStream", () => {
  FakeEventSource.last = undefined;
  const stream = new SseEventStream({
    url: "https://example.test/sse",
    eventSourceCtor: FakeEventSource,
  });
  return {
    stream,
    connects: true,
    open: () => FakeEventSource.last?.emitOpen(),
  };
});

conformance("WebSocketEventStream", () => {
  FakeWebSocket.last = undefined;
  const stream = new WebSocketEventStream({
    url: "wss://example.test/ws",
    webSocketCtor: FakeWebSocket,
  });
  return {
    stream,
    connects: true,
    open: () => FakeWebSocket.last?.emitOpen(),
  };
});

conformance("NoopEventStream", () => ({
  stream: new NoopEventStream(),
  connects: false,
  open: () => {
    /* never connects */
  },
}));

describe("NoopEventStream (ES-5)", () => {
  it("warns on construction that it is inert", () => {
    const warns: string[] = [];
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (message: string) => warns.push(message),
      error: () => undefined,
      with: () => logger,
      child: () => logger,
      withSpan: () => logger,
    };
    new NoopEventStream({ logger });
    expect(warns.some((w) => w.includes("noop transport is inert"))).toBe(true);
  });
});
