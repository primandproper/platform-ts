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
import { WebSocketEventStream } from "./providers/websocket.js";

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
  readonly #listeners = new Map<string, (ev: EventSourceMessage) => void>();

  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }

  addEventListener(type: string, listener: (ev: EventSourceMessage) => void): void {
    this.#listeners.set(type, listener);
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

  emitError(err: unknown): void {
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

  it("fires onError on a transport error", () => {
    const { stream, source } = make();
    const onError = vi.fn();
    stream.onError(onError);

    stream.connect();
    const boom = new Error("boom");
    source().emitError(boom);

    expect(onError).toHaveBeenCalledWith(boom);
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
