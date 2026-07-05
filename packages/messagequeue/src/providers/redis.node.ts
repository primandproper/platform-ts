import {
  makeObserver,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";
import { Cluster, Redis } from "ioredis";

import {
  ErrEmptyTopicName,
  type Consumer,
  type ConsumerFunc,
  type ConsumerProvider,
  type Publisher,
  type PublisherProvider,
} from "../messagequeue.js";

import {
  consumerInstruments,
  type ConsumerInstruments,
  encodeJSON,
  LENGTH_KEY,
  publisherInstruments,
  TOPIC_KEY,
  TopicCache,
  type PublisherInstruments,
} from "./support.js";

/** Redis connection config. Faithful to Go's `redis.Config`. */
export interface RedisMessageQueueOptions {
  /** One or more `host:port` addresses. Multiple addresses select a cluster client. */
  queueAddresses: string[];
  username?: string | undefined;
  password?: string | undefined;
}

/** The subset of the ioredis surface both {@link Redis} and {@link Cluster} share that we use. */
interface PubSubConn {
  publish(channel: string, message: Buffer): Promise<number>;
  subscribe(...channels: string[]): Promise<unknown>;
  unsubscribe(...channels: string[]): Promise<unknown>;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
  disconnect(): void;
  on(
    event: "messageBuffer",
    listener: (channel: Buffer, message: Buffer) => void,
  ): unknown;
}

/** Parses a Redis `host[:port]` address, including bracketed and bare IPv6. Exported for testing. */
export function parseAddress(address: string): { host: string; port: number } {
  // Bracketed IPv6, optionally with a port: `[::1]` or `[::1]:6379`. Brackets are stripped from
  // the host since ioredis expects the bare literal.
  if (address.startsWith("[")) {
    const end = address.indexOf("]");
    if (end !== -1) {
      const host = address.slice(1, end);
      const rest = address.slice(end + 1);
      const port = rest.startsWith(":") ? Number(rest.slice(1)) || 6379 : 6379;
      return { host, port };
    }
  }
  const first = address.indexOf(":");
  // No colon (bare host) or more than one colon (an unbracketed IPv6 literal with no port) both
  // mean the whole string is the host and the default port applies. A single colon is host:port.
  if (first === -1 || first !== address.lastIndexOf(":")) {
    return { host: address, port: 6379 };
  }
  return {
    host: address.slice(0, first),
    port: Number(address.slice(first + 1)) || 6379,
  };
}

/** Builds a single-node or cluster client from the configured addresses. */
function createRedisClient(options: RedisMessageQueueOptions): PubSubConn {
  const { username, password } = options;
  const nodes = options.queueAddresses.map(parseAddress);

  if (nodes.length > 1) {
    return new Cluster(nodes, {
      redisOptions: { username, password, lazyConnect: true },
    });
  }

  const node = nodes[0] ?? { host: "localhost", port: 6379 };
  return new Redis({
    host: node.host,
    port: node.port,
    username,
    password,
    lazyConnect: true,
  });
}

class RedisPublisher implements Publisher {
  readonly #client: PubSubConn;
  readonly #topic: string;
  readonly #observer: Observer;
  readonly #instruments: PublisherInstruments;

  constructor(client: PubSubConn, topic: string, deps?: ObservabilityDeps) {
    this.#client = client;
    this.#topic = topic;
    this.#observer = deps?.observer ?? makeObserver(`${topic}_publisher`, deps);
    this.#instruments = publisherInstruments(deps, topic);
  }

  async publish(data: unknown): Promise<void> {
    await this.#observer.run("publish", async (op) => {
      let bytes: Uint8Array;
      try {
        bytes = encodeJSON(data);
      } catch (err) {
        this.#instruments.publishErrors.add(1);
        throw op.error(err, "encoding topic message");
      }

      op.set(TOPIC_KEY, this.#topic).set(LENGTH_KEY, bytes.length);

      const start = performance.now();
      try {
        await this.#client.publish(this.#topic, Buffer.from(bytes));
      } catch (err) {
        this.#instruments.publishErrors.add(1);
        throw op.error(err, "publishing message");
      }

      this.#instruments.published.add(1);
      this.#instruments.latency.record(performance.now() - start);
    });
  }

  publishAsync(data: unknown): void {
    this.publish(data).catch((err: unknown) => {
      this.#observer.logger().error("publishing message", err);
    });
  }

  // The publishing connection is owned by the provider, which closes it; a per-publisher stop
  // would tear the shared client out from under sibling publishers.
  stop(): Promise<void> {
    return Promise.resolve();
  }
}

/** A {@link PublisherProvider} backed by Redis PUBLISH. Faithful to Go's `redis` publisher. */
export class RedisPublisherProvider implements PublisherProvider {
  readonly #client: PubSubConn;
  readonly #deps: ObservabilityDeps | undefined;
  readonly #cache = new TopicCache<Publisher>();

  constructor(options: RedisMessageQueueOptions, deps?: ObservabilityDeps) {
    this.#client = createRedisClient(options);
    this.#deps = deps;
  }

  providePublisher(topic: string): Promise<Publisher> {
    if (topic === "") {
      return Promise.reject(ErrEmptyTopicName);
    }
    return this.#cache.getOrBuild(topic, () =>
      Promise.resolve(new RedisPublisher(this.#client, topic, this.#deps)),
    );
  }

  async ping(): Promise<void> {
    await this.#client.ping();
  }

  async close(): Promise<void> {
    this.#cache.clear();
    await this.#client.quit().catch(() => {
      this.#client.disconnect();
    });
  }
}

class RedisConsumer implements Consumer {
  readonly #options: RedisMessageQueueOptions;
  readonly #topic: string;
  readonly #handler: ConsumerFunc;
  readonly #observer: Observer;
  readonly #instruments: ConsumerInstruments;
  #sub: PubSubConn | undefined;
  #stopped = false;
  #resolveDone: (() => void) | undefined;
  // Serializes handler delivery: each incoming message is chained onto the previous one so a flood
  // can never spawn unbounded concurrent handlers (LC-11).
  #tail: Promise<void> = Promise.resolve();

  constructor(
    options: RedisMessageQueueOptions,
    topic: string,
    handler: ConsumerFunc,
    deps?: ObservabilityDeps,
  ) {
    this.#options = options;
    this.#topic = topic;
    this.#handler = handler;
    this.#observer = deps?.observer ?? makeObserver(`${topic}_consumer`, deps);
    this.#instruments = consumerInstruments(deps, topic);
  }

  /** Fire-and-forget teardown (the abort path); {@link close} is the awaitable variant. */
  #stop(): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    const sub = this.#sub;
    if (sub !== undefined) {
      sub.unsubscribe(this.#topic).catch(() => undefined);
      sub.quit().catch(() => {
        sub.disconnect();
      });
    }
    this.#resolveDone?.();
  }

  async consume(signal?: AbortSignal, onError?: (err: unknown) => void): Promise<void> {
    if (signal?.aborted) {
      return;
    }

    const done = new Promise<void>((resolve) => {
      this.#resolveDone = resolve;
    });

    // Register the abort listener BEFORE the SUBSCRIBE await so an abort landing mid-subscribe is
    // not missed — otherwise consume() would hang forever (LC-8).
    signal?.addEventListener(
      "abort",
      () => {
        this.#stop();
      },
      { once: true },
    );

    // A dedicated connection: once a Redis connection subscribes it enters subscriber mode and
    // can no longer issue ordinary commands, so the consumer never shares the publisher's client.
    const sub = createRedisClient(this.#options);
    this.#sub = sub;

    sub.on("messageBuffer", (_channel, message) => {
      this.#tail = this.#tail.then(() => this.#deliver(message, onError));
    });

    // Block until Redis confirms the SUBSCRIBE, mirroring Go's `subscription.Receive`: without
    // it a publisher racing us would silently drop the first message, since Redis pub/sub does
    // not buffer for late subscribers.
    try {
      await sub.subscribe(this.#topic);
    } catch (err) {
      onError?.(err);
      this.#stop();
      return done;
    }
    this.#observer.logger().debug("subscribed to topic", { topic: this.#topic });

    return done;
  }

  /** Awaitable teardown for provider.close(): drains in-flight delivery, then quits the socket. */
  async close(): Promise<void> {
    const alreadyStopped = this.#stopped;
    this.#stopped = true;
    this.#resolveDone?.();
    await this.#tail.catch(() => undefined);
    if (alreadyStopped) {
      return;
    }
    const sub = this.#sub;
    if (sub !== undefined) {
      await sub.unsubscribe(this.#topic).catch(() => undefined);
      await sub.quit().catch(() => {
        sub.disconnect();
      });
    }
  }

  async #deliver(message: Buffer, onError?: (err: unknown) => void): Promise<void> {
    await this.#observer.run("consume_message", async (op) => {
      op.set(TOPIC_KEY, this.#topic).set(LENGTH_KEY, message.length);
      try {
        await this.#handler(new Uint8Array(message));
        this.#instruments.consumed.add(1);
      } catch (err) {
        this.#instruments.consumeErrors.add(1);
        op.acknowledge(err, "handling message");
        onError?.(err);
      }
    });
  }
}

/** A {@link ConsumerProvider} backed by Redis SUBSCRIBE. Faithful to Go's `redis` consumer. */
export class RedisConsumerProvider implements ConsumerProvider {
  readonly #options: RedisMessageQueueOptions;
  readonly #deps: ObservabilityDeps | undefined;
  readonly #cache = new TopicCache<RedisConsumer>();

  constructor(options: RedisMessageQueueOptions, deps?: ObservabilityDeps) {
    this.#options = options;
    this.#deps = deps;
  }

  provideConsumer(topic: string, handler: ConsumerFunc): Promise<Consumer> {
    if (topic === "") {
      return Promise.reject(ErrEmptyTopicName);
    }
    return this.#cache.getOrBuild(
      topic,
      () => Promise.resolve(new RedisConsumer(this.#options, topic, handler, this.#deps)),
      handler,
    );
  }

  async close(): Promise<void> {
    // Each consumer owns its own subscriber socket (created inside consume()); close them all so a
    // subscribing consumer's connection is released rather than leaking.
    const consumers = [...this.#cache.values()];
    this.#cache.clear();
    await Promise.allSettled(consumers.map(async (c) => (await c).close()));
  }
}
