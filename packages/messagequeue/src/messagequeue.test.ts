import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { MemoryMessageQueue } from "./providers/memory.js";
import { NoopMessageQueue } from "./providers/noop.js";
import { RedisMessageQueue } from "./providers/redis.node.js";

import { provideMessageQueue, type Message, type MessageQueue } from "./index.js";

/**
 * Live-Redis integration is opt-in: set MESSAGEQUEUE_TEST_REDIS_URL to a reachable Redis
 * (e.g. redis://localhost:6379) to run the conformance + delivery suites against Redis Streams.
 * The default offline run skips them and stays green. Each instance gets a unique key prefix so
 * leftover streams never collide on a shared server.
 */
const REDIS_URL = process.env.MESSAGEQUEUE_TEST_REDIS_URL;

const redisQueue = (): RedisMessageQueue =>
  new RedisMessageQueue({
    url: REDIS_URL ?? "redis://localhost:6379",
    keyPrefix: `mqtest:${randomUUID()}:`,
    blockMs: 200,
  });

/**
 * Provider-agnostic conformance suite. Running the same assertions against multiple
 * providers proves the `MessageQueue` interface is implementation-independent.
 */
function conformance(name: string, make: () => MessageQueue): void {
  describe(name, () => {
    it("publishes without throwing", async () => {
      await expect(make().publish("topic", { body: "hello" })).resolves.toBeUndefined();
    });

    it("subscribes and returns a Subscription", async () => {
      const sub = await make().subscribe("topic", () => Promise.resolve());
      await expect(sub.unsubscribe()).resolves.toBeUndefined();
    });

    it("pings without throwing", async () => {
      await expect(make().ping()).resolves.toBeUndefined();
    });
  });
}

conformance("MemoryMessageQueue", () => new MemoryMessageQueue());
conformance("NoopMessageQueue", () => new NoopMessageQueue());

describe.skipIf(!REDIS_URL)("RedisMessageQueue (live)", () => {
  conformance("RedisMessageQueue", redisQueue);

  it("delivers a published message to a subscriber", async () => {
    const mq = redisQueue();
    const received = new Promise<Message>((resolve) => {
      void mq.subscribe("topic", (message) => {
        resolve(message);
        return Promise.resolve();
      });
    });

    // Give the consumer-group read loop a beat to park before publishing.
    await new Promise((r) => setTimeout(r, 100));
    await mq.publish("topic", { id: "1", body: "hello", attributes: { k: "v" } });

    const message = await received;
    expect(message).toEqual({ id: "1", body: "hello", attributes: { k: "v" } });
  });

  it("stops delivery after unsubscribe", async () => {
    const mq = redisQueue();
    const handler = vi.fn(() => Promise.resolve());

    const sub = await mq.subscribe("topic", handler);
    await sub.unsubscribe();
    await mq.publish("topic", { id: "1", body: "hello" });
    await new Promise((r) => setTimeout(r, 300));

    expect(handler).not.toHaveBeenCalled();
  });
});

describe("MemoryMessageQueue delivery", () => {
  it("delivers a published message to a subscriber", async () => {
    const mq = new MemoryMessageQueue();
    const handler = vi.fn(() => Promise.resolve());

    await mq.subscribe("topic", handler);
    await mq.publish("topic", { id: "1", body: "hello" });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ id: "1", body: "hello" });
  });

  it("delivers to every subscriber of a topic", async () => {
    const mq = new MemoryMessageQueue();
    const first = vi.fn(() => Promise.resolve());
    const second = vi.fn(() => Promise.resolve());

    await mq.subscribe("topic", first);
    await mq.subscribe("topic", second);
    await mq.publish("topic", { id: "1", body: "hello" });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("stops delivery after unsubscribe", async () => {
    const mq = new MemoryMessageQueue();
    const handler = vi.fn(() => Promise.resolve());

    const sub = await mq.subscribe("topic", handler);
    await sub.unsubscribe();
    await mq.publish("topic", { id: "1", body: "hello" });

    expect(handler).not.toHaveBeenCalled();
  });

  it("generates an id when none is supplied", async () => {
    const mq = new MemoryMessageQueue();
    const received: string[] = [];

    await mq.subscribe("topic", (message) => {
      received.push(message.id);
      return Promise.resolve();
    });
    await mq.publish("topic", { body: "hello" });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatch(/[0-9a-f-]{36}/);
  });

  it("carries attributes through to the subscriber", async () => {
    const mq = new MemoryMessageQueue();
    const handler = vi.fn(() => Promise.resolve());

    await mq.subscribe("topic", handler);
    await mq.publish("topic", { id: "1", body: "hello", attributes: { k: "v" } });

    expect(handler).toHaveBeenCalledWith({
      id: "1",
      body: "hello",
      attributes: { k: "v" },
    });
  });
});

describe("provideMessageQueue", () => {
  it("defaults to the memory provider", () => {
    expect(provideMessageQueue(undefined, {})).toBeInstanceOf(MemoryMessageQueue);
  });

  it("builds a noop provider", () => {
    expect(provideMessageQueue({ provider: "noop" })).toBeInstanceOf(NoopMessageQueue);
  });

  it("builds a redis provider when configured", () => {
    expect(
      provideMessageQueue({
        provider: "redis",
        redis: { url: "redis://localhost:6379" },
      }),
    ).toBeInstanceOf(RedisMessageQueue);
  });

  it("rejects the redis provider without redis config", () => {
    expect(() => provideMessageQueue({ provider: "redis" })).toThrow();
  });
});
