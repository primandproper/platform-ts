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
  consumedCounter,
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

function parseAddress(address: string): { host: string; port: number } {
  const idx = address.lastIndexOf(":");
  if (idx === -1) {
    return { host: address, port: 6379 };
  }
  return { host: address.slice(0, idx), port: Number(address.slice(idx + 1)) || 6379 };
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
    this.#observer = makeObserver(`${topic}_publisher`, deps);
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
  stop(): void {}
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

  close(): void {
    this.#cache.clear();
    this.#client.quit().catch(() => {
      this.#client.disconnect();
    });
  }
}

class RedisConsumer implements Consumer {
  readonly #options: RedisMessageQueueOptions;
  readonly #topic: string;
  readonly #handler: ConsumerFunc;
  readonly #observer: Observer;
  readonly #consumed: ReturnType<typeof consumedCounter>;

  constructor(
    options: RedisMessageQueueOptions,
    topic: string,
    handler: ConsumerFunc,
    deps?: ObservabilityDeps,
  ) {
    this.#options = options;
    this.#topic = topic;
    this.#handler = handler;
    this.#observer = makeObserver(`${topic}_consumer`, deps);
    this.#consumed = consumedCounter(deps, topic);
  }

  async consume(signal?: AbortSignal, onError?: (err: unknown) => void): Promise<void> {
    if (signal?.aborted) {
      return;
    }

    // A dedicated connection: once a Redis connection subscribes it enters subscriber mode and
    // can no longer issue ordinary commands, so the consumer never shares the publisher's client.
    const sub = createRedisClient(this.#options);

    sub.on("messageBuffer", (_channel, message) => {
      void this.#deliver(message, onError);
    });

    // Block until Redis confirms the SUBSCRIBE, mirroring Go's `subscription.Receive`: without
    // it a publisher racing us would silently drop the first message, since Redis pub/sub does
    // not buffer for late subscribers.
    await sub.subscribe(this.#topic);
    this.#observer.logger().debug("subscribed to topic");

    return new Promise<void>((resolve) => {
      const stop = (): void => {
        sub.unsubscribe(this.#topic).catch(() => undefined);
        sub.quit().catch(() => {
          sub.disconnect();
        });
        resolve();
      };
      signal?.addEventListener("abort", stop, { once: true });
    });
  }

  async #deliver(message: Buffer, onError?: (err: unknown) => void): Promise<void> {
    await this.#observer.run("consume_message", async (op) => {
      op.set(TOPIC_KEY, this.#topic).set(LENGTH_KEY, message.length);
      this.#consumed.add(1);
      try {
        await this.#handler(new Uint8Array(message));
      } catch (err) {
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
  readonly #cache = new TopicCache<Consumer>();

  constructor(options: RedisMessageQueueOptions, deps?: ObservabilityDeps) {
    this.#options = options;
    this.#deps = deps;
  }

  provideConsumer(topic: string, handler: ConsumerFunc): Promise<Consumer> {
    if (topic === "") {
      return Promise.reject(ErrEmptyTopicName);
    }
    return this.#cache.getOrBuild(topic, () =>
      Promise.resolve(new RedisConsumer(this.#options, topic, handler, this.#deps)),
    );
  }
}
