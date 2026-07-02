import { describe, expect, it, vi } from "vitest";

import type { Notification, NotificationClient } from "./notifications.js";
import { InMemoryNotificationClient } from "./providers/memory.js";
import { NoopNotificationClient } from "./providers/noop.js";
import {
  WebSocketNotificationClient,
  type WebSocketLike,
} from "./providers/websocket.js";

function note(overrides: Partial<Notification> = {}): Notification {
  return {
    id: "n1",
    channel: "alerts",
    type: "ping",
    payload: { ok: true },
    ...overrides,
  };
}

describe("InMemoryNotificationClient", () => {
  it("routes a publish to the matching channel handler only", () => {
    const client = new InMemoryNotificationClient();
    const alerts = vi.fn();
    const billing = vi.fn();
    client.subscribe("alerts", alerts);
    client.subscribe("billing", billing);

    const n = note({ channel: "alerts" });
    client.publish(n);

    expect(alerts).toHaveBeenCalledOnce();
    expect(alerts).toHaveBeenCalledWith(n);
    expect(billing).not.toHaveBeenCalled();
  });

  it("stops delivery after unsubscribe", () => {
    const client = new InMemoryNotificationClient();
    const handler = vi.fn();
    const unsubscribe = client.subscribe("alerts", handler);

    client.publish(note());
    unsubscribe();
    client.publish(note({ id: "n2" }));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("is idempotent on repeated unsubscribe", () => {
    const client = new InMemoryNotificationClient();
    const handler = vi.fn();
    const unsubscribe = client.subscribe("alerts", handler);
    unsubscribe();
    unsubscribe();

    client.publish(note());
    expect(handler).not.toHaveBeenCalled();
  });

  it("delivers every notification to onNotification regardless of channel", () => {
    const client = new InMemoryNotificationClient();
    const observer = vi.fn();
    client.onNotification(observer);

    client.publish(note({ channel: "alerts" }));
    client.publish(note({ id: "n2", channel: "billing" }));

    expect(observer).toHaveBeenCalledTimes(2);
  });

  it("isolates a throwing handler from the others", () => {
    const client = new InMemoryNotificationClient();
    const good = vi.fn();
    client.subscribe("alerts", () => {
      throw new Error("boom");
    });
    client.subscribe("alerts", good);

    expect(() => {
      client.publish(note());
    }).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("tracks connect/close state", () => {
    const client = new InMemoryNotificationClient();
    expect(client.state).toBe("idle");
    client.connect();
    expect(client.state).toBe("open");
    client.close();
    expect(client.state).toBe("closed");
  });
});

describe("NoopNotificationClient", () => {
  it("subscribes and connects without effect", () => {
    const client: NotificationClient = new NoopNotificationClient();
    const handler = vi.fn();
    const unsubscribe = client.subscribe("alerts", handler);
    client.connect();
    client.close();
    unsubscribe();
    expect(handler).not.toHaveBeenCalled();
    expect(client.state).toBe("idle");
  });
});

/** A controllable fake `WebSocket` — no real socket is ever opened. */
class FakeWebSocket implements WebSocketLike {
  readonly #listeners = {
    open: new Set<() => void>(),
    close: new Set<() => void>(),
    message: new Set<(event: { data: unknown }) => void>(),
  };
  closed = false;

  addEventListener(type: "open" | "close", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "open" | "close" | "message", listener: unknown): void {
    if (type === "message") {
      this.#listeners.message.add(listener as (event: { data: unknown }) => void);
    } else {
      this.#listeners[type].add(listener as () => void);
    }
  }

  close(): void {
    this.closed = true;
    for (const listener of this.#listeners.close) {
      listener();
    }
  }

  emitOpen(): void {
    for (const listener of this.#listeners.open) {
      listener();
    }
  }

  emitMessage(data: unknown): void {
    for (const listener of this.#listeners.message) {
      listener({ data });
    }
  }
}

describe("WebSocketNotificationClient", () => {
  function setup(): { client: WebSocketNotificationClient; socket: FakeWebSocket } {
    const socket = new FakeWebSocket();
    const client = new WebSocketNotificationClient({
      url: "wss://example.test/ws",
      webSocketFactory: () => socket,
    });
    return { client, socket };
  }

  it("dispatches an inbound JSON frame to the channel subscriber", () => {
    const { client, socket } = setup();
    const handler = vi.fn();
    client.subscribe("alerts", handler);
    client.connect();

    const n = note({ channel: "alerts" });
    socket.emitMessage(JSON.stringify(n));

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(n);
  });

  it("routes only to the matching channel", () => {
    const { client, socket } = setup();
    const alerts = vi.fn();
    const billing = vi.fn();
    client.subscribe("alerts", alerts);
    client.subscribe("billing", billing);
    client.connect();

    socket.emitMessage(JSON.stringify(note({ channel: "billing" })));

    expect(billing).toHaveBeenCalledTimes(1);
    expect(alerts).not.toHaveBeenCalled();
  });

  it("drops malformed frames without throwing", () => {
    const { client, socket } = setup();
    const observer = vi.fn();
    client.onNotification(observer);
    client.connect();

    expect(() => {
      socket.emitMessage("not json");
    }).not.toThrow();
    expect(() => {
      socket.emitMessage(JSON.stringify({ id: 1 }));
    }).not.toThrow();
    expect(observer).not.toHaveBeenCalled();
  });

  it("manages state across connect, open, and close", () => {
    const { client, socket } = setup();
    expect(client.state).toBe("idle");

    client.connect();
    expect(client.state).toBe("connecting");

    socket.emitOpen();
    expect(client.state).toBe("open");

    client.close();
    expect(client.state).toBe("closed");
    expect(socket.closed).toBe(true);
  });

  it("connects only once while already connecting or open", () => {
    const factory = vi.fn(() => new FakeWebSocket());
    const client = new WebSocketNotificationClient({
      url: "wss://example.test/ws",
      webSocketFactory: factory,
    });

    client.connect();
    client.connect();

    expect(factory).toHaveBeenCalledTimes(1);
  });
});
