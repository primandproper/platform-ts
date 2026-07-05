import type { MeterProvider } from "@primandproper/observability";
import { describe, expect, it, vi } from "vitest";

import { parseAddress } from "./providers/redis.node.js";

import {
  type ConsumerProvider,
  ErrConsumerHandlerMismatch,
  ErrEmptyTopicName,
  KafkaConsumerProvider,
  KafkaPublisherProvider,
  MemoryBroker,
  MemoryConsumerProvider,
  MemoryPublisherProvider,
  NoopConsumerProvider,
  NoopPublisherProvider,
  provideConsumerProvider,
  providePublisherProvider,
  type PublisherProvider,
  PubSubConsumerProvider,
  PubSubPublisherProvider,
  RedisConsumerProvider,
  RedisPublisherProvider,
  SQSConsumerProvider,
  SQSPublisherProvider,
} from "./index.js";

const decode = (data: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(data));

/** Waits a microtask-ish beat so background delivery loops can run. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("MemoryBroker round-trip", () => {
  it("delivers a published message to a consuming consumer", async () => {
    const broker = new MemoryBroker();
    const publishers = new MemoryPublisherProvider(broker);
    const consumers = new MemoryConsumerProvider(broker);

    const received: unknown[] = [];
    const consumer = await consumers.provideConsumer("topic", (data) => {
      received.push(decode(data));
      return Promise.resolve();
    });

    const stop = new AbortController();
    void consumer.consume(stop.signal);

    const publisher = await publishers.providePublisher("topic");
    await publisher.publish({ hello: "world" });

    expect(received).toEqual([{ hello: "world" }]);
    stop.abort();
  });

  it("reports handler errors through onError without throwing to the publisher", async () => {
    const broker = new MemoryBroker();
    const consumers = new MemoryConsumerProvider(broker);
    const publishers = new MemoryPublisherProvider(broker);

    const boom = new Error("handler blew up");
    const errors: unknown[] = [];
    const consumer = await consumers.provideConsumer("topic", () => Promise.reject(boom));

    const stop = new AbortController();
    void consumer.consume(stop.signal, (err) => errors.push(err));

    const publisher = await publishers.providePublisher("topic");
    await expect(publisher.publish({ n: 1 })).resolves.toBeUndefined();

    expect(errors).toEqual([boom]);
    stop.abort();
  });

  it("stops delivery once the consume signal aborts", async () => {
    const broker = new MemoryBroker();
    const handler = vi.fn(() => Promise.resolve());
    const consumer = await new MemoryConsumerProvider(broker).provideConsumer(
      "topic",
      handler,
    );
    const publisher = await new MemoryPublisherProvider(broker).providePublisher("topic");

    const stop = new AbortController();
    const done = consumer.consume(stop.signal);
    stop.abort();
    await done;

    await publisher.publish({ n: 1 });
    expect(handler).not.toHaveBeenCalled();
  });
});

/** A meter provider that tallies counter `add`s by instrument name. */
function recordingMeter(): { provider: MeterProvider; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  const counter = (name: string) => ({
    add: (value: number) => {
      counts[name] = (counts[name] ?? 0) + value;
    },
  });
  const meter = {
    createCounter: (name: string) => counter(name),
    createUpDownCounter: (name: string) => counter(name),
    createHistogram: () => ({ record: () => undefined }),
    createGauge: () => ({ record: () => undefined }),
  };
  return {
    provider: { getMeter: () => meter } as unknown as MeterProvider,
    counts,
  };
}

describe("consumer handler cache (MQ-2)", () => {
  it("returns the same consumer for the same topic+handler", async () => {
    const consumers = new MemoryConsumerProvider(new MemoryBroker());
    const handler = (): Promise<void> => Promise.resolve();
    const a = await consumers.provideConsumer("topic", handler);
    const b = await consumers.provideConsumer("topic", handler);
    expect(a).toBe(b);
  });

  it("rejects a second consumer for the same topic with a different handler", async () => {
    const consumers = new MemoryConsumerProvider(new MemoryBroker());
    await consumers.provideConsumer("topic", () => Promise.resolve());
    await expect(
      consumers.provideConsumer("topic", () => Promise.resolve()),
    ).rejects.toBe(ErrConsumerHandlerMismatch);
  });
});

describe("consumer metrics (MQ-3)", () => {
  it("counts consumed only after a successful handler and errors on failure", async () => {
    const broker = new MemoryBroker();
    const { provider, counts } = recordingMeter();
    const consumers = new MemoryConsumerProvider(broker, { metrics: provider });
    const publishers = new MemoryPublisherProvider(broker);

    let calls = 0;
    const consumer = await consumers.provideConsumer("topic", () => {
      calls += 1;
      // Fail the first message, succeed the second.
      return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve();
    });
    const stop = new AbortController();
    void consumer.consume(stop.signal, () => undefined);

    const publisher = await publishers.providePublisher("topic");
    await publisher.publish({ n: 1 });
    await publisher.publish({ n: 2 });
    await tick();

    expect(counts.topic_consumed).toBe(1);
    expect(counts.topic_consume_errors).toBe(1);
    stop.abort();
  });
});

describe("parseAddress (MQ-4)", () => {
  it("parses IPv4 host:port and bare host", () => {
    expect(parseAddress("localhost:6379")).toEqual({ host: "localhost", port: 6379 });
    expect(parseAddress("redis.example.com")).toEqual({
      host: "redis.example.com",
      port: 6379,
    });
  });

  it("parses bracketed IPv6 with and without a port", () => {
    expect(parseAddress("[::1]:6380")).toEqual({ host: "::1", port: 6380 });
    expect(parseAddress("[2001:db8::1]:6379")).toEqual({
      host: "2001:db8::1",
      port: 6379,
    });
    expect(parseAddress("[::1]")).toEqual({ host: "::1", port: 6379 });
  });

  it("treats a bare IPv6 literal as the host with the default port", () => {
    expect(parseAddress("::1")).toEqual({ host: "::1", port: 6379 });
    expect(parseAddress("2001:db8::1")).toEqual({ host: "2001:db8::1", port: 6379 });
  });
});

describe("empty topic", () => {
  it("rejects providePublisher with ErrEmptyTopicName", async () => {
    await expect(new MemoryPublisherProvider().providePublisher("")).rejects.toBe(
      ErrEmptyTopicName,
    );
  });

  it("rejects provideConsumer with ErrEmptyTopicName", async () => {
    await expect(
      new MemoryConsumerProvider().provideConsumer("", () => Promise.resolve()),
    ).rejects.toBe(ErrEmptyTopicName);
  });
});

describe("noop providers", () => {
  it("publishes and pings without throwing", async () => {
    const provider: PublisherProvider = new NoopPublisherProvider();
    const publisher = await provider.providePublisher("topic");
    await expect(publisher.publish({ n: 1 })).resolves.toBeUndefined();
    await expect(provider.ping()).resolves.toBeUndefined();
    expect(() => {
      publisher.publishAsync({ n: 1 });
    }).not.toThrow();
    await expect(provider.close()).resolves.toBeUndefined();
  });

  it("consume resolves once aborted", async () => {
    const provider: ConsumerProvider = new NoopConsumerProvider();
    const consumer = await provider.provideConsumer("topic", () => Promise.resolve());
    const stop = new AbortController();
    const done = consumer.consume(stop.signal);
    stop.abort();
    await expect(done).resolves.toBeUndefined();
  });
});

describe("publishAsync", () => {
  it("swallows publish errors instead of rejecting", async () => {
    const broker = new MemoryBroker();
    const publisher = await new MemoryPublisherProvider(broker).providePublisher("topic");

    // A value with a circular reference makes JSON encoding throw inside publish.
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => {
      publisher.publishAsync(circular);
    }).not.toThrow();
    await tick();
  });
});

describe("providePublisherProvider", () => {
  it("defaults to the memory provider", () => {
    expect(providePublisherProvider(undefined, {})).toBeInstanceOf(
      MemoryPublisherProvider,
    );
  });

  it("builds a noop provider", () => {
    expect(providePublisherProvider({ provider: "noop" })).toBeInstanceOf(
      NoopPublisherProvider,
    );
  });

  it("builds a redis provider when configured", () => {
    expect(
      providePublisherProvider({
        provider: "redis",
        redis: { queueAddresses: ["localhost:6379"] },
      }),
    ).toBeInstanceOf(RedisPublisherProvider);
  });

  it("builds an sqs provider", () => {
    expect(providePublisherProvider({ provider: "sqs" })).toBeInstanceOf(
      SQSPublisherProvider,
    );
  });

  it("builds a pubsub provider when configured", () => {
    expect(
      providePublisherProvider({ provider: "pubsub", pubsub: { projectId: "p" } }),
    ).toBeInstanceOf(PubSubPublisherProvider);
  });

  it("builds a kafka provider when configured", () => {
    expect(
      providePublisherProvider({
        provider: "kafka",
        kafka: { brokers: ["localhost:9092"] },
      }),
    ).toBeInstanceOf(KafkaPublisherProvider);
  });

  it("rejects redis/pubsub/kafka without their config block", () => {
    expect(() => providePublisherProvider({ provider: "redis" })).toThrow();
    expect(() => providePublisherProvider({ provider: "pubsub" })).toThrow();
    expect(() => providePublisherProvider({ provider: "kafka" })).toThrow();
  });
});

describe("provideConsumerProvider", () => {
  it("defaults to the memory provider", () => {
    expect(provideConsumerProvider(undefined, {})).toBeInstanceOf(MemoryConsumerProvider);
  });

  it("builds each configured provider", () => {
    expect(provideConsumerProvider({ provider: "noop" })).toBeInstanceOf(
      NoopConsumerProvider,
    );
    expect(provideConsumerProvider({ provider: "sqs" })).toBeInstanceOf(
      SQSConsumerProvider,
    );
    expect(
      provideConsumerProvider({
        provider: "redis",
        redis: { queueAddresses: ["localhost:6379"] },
      }),
    ).toBeInstanceOf(RedisConsumerProvider);
    expect(
      provideConsumerProvider({ provider: "pubsub", pubsub: { projectId: "p" } }),
    ).toBeInstanceOf(PubSubConsumerProvider);
    expect(
      provideConsumerProvider({
        provider: "kafka",
        kafka: { brokers: ["localhost:9092"] },
      }),
    ).toBeInstanceOf(KafkaConsumerProvider);
  });
});

/**
 * Live Redis PUB/SUB integration is opt-in: set MESSAGEQUEUE_TEST_REDIS_ADDR to a reachable
 * `host:port` (e.g. localhost:6379). The default offline run skips it and stays green.
 */
const REDIS_ADDR = process.env.MESSAGEQUEUE_TEST_REDIS_ADDR;

describe.skipIf(!REDIS_ADDR)("Redis PUB/SUB (live)", () => {
  it("delivers a published message across publisher and consumer providers", async () => {
    const options = { queueAddresses: [REDIS_ADDR ?? "localhost:6379"] };
    const topic = `mqtest:${Math.trunc(performance.now()).toString()}`;

    const consumers = new RedisConsumerProvider(options);
    const publishers = new RedisPublisherProvider(options);

    const received = new Promise<unknown>((resolve) => {
      void consumers
        .provideConsumer(topic, (data) => {
          resolve(decode(data));
          return Promise.resolve();
        })
        .then((consumer) => consumer.consume(new AbortController().signal));
    });

    await tick();
    const publisher = await publishers.providePublisher(topic);
    // Give the SUBSCRIBE a beat to land before publishing.
    await new Promise((r) => setTimeout(r, 100));
    await publisher.publish({ hello: "redis" });

    expect(await received).toEqual({ hello: "redis" });
    await publishers.close();
    await consumers.close();
  });
});
