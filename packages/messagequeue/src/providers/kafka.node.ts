import {
  makeObserver,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";
import { type Consumer as KafkaReader, Kafka, type Producer } from "kafkajs";

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

/** Kafka config. Faithful to Go's `kafka.Config`. */
export interface KafkaMessageQueueOptions {
  brokers: string[];
  /** Consumer group id. Required for consuming; ignored by publishers. */
  groupId?: string | undefined;
}

class KafkaPublisher implements Publisher {
  readonly #producer: Producer;
  readonly #topic: string;
  readonly #observer: Observer;
  readonly #instruments: PublisherInstruments;
  #connected?: Promise<void>;

  constructor(kafka: Kafka, topic: string, deps?: ObservabilityDeps) {
    this.#producer = kafka.producer({ allowAutoTopicCreation: true });
    this.#topic = topic;
    this.#observer = deps?.observer ?? makeObserver(`${topic}_publisher`, deps);
    this.#instruments = publisherInstruments(deps, topic);
  }

  #connect(): Promise<void> {
    this.#connected ??= this.#producer.connect();
    return this.#connected;
  }

  async publish(data: unknown): Promise<void> {
    await this.#observer.run("publish", async (op) => {
      op.set(TOPIC_KEY, this.#topic);

      let bytes: Uint8Array;
      try {
        bytes = encodeJSON(data);
      } catch (err) {
        this.#instruments.publishErrors.add(1);
        throw op.error(err, "encoding topic message");
      }

      op.set(LENGTH_KEY, bytes.length);

      const start = performance.now();
      try {
        await this.#connect();
        await this.#producer.send({
          topic: this.#topic,
          messages: [{ value: Buffer.from(bytes) }],
        });
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

  async stop(): Promise<void> {
    if (this.#connected === undefined) {
      return;
    }
    // Await the disconnect so kafkajs flushes any in-flight produce before we resolve.
    try {
      await this.#producer.disconnect();
    } catch (err) {
      this.#observer.logger().error("closing kafka producer", err);
    }
  }
}

/** A {@link PublisherProvider} backed by Kafka. Faithful to Go's `kafka` publisher. */
export class KafkaPublisherProvider implements PublisherProvider {
  readonly #kafka: Kafka;
  readonly #deps: ObservabilityDeps | undefined;
  readonly #cache = new TopicCache<Publisher>();

  constructor(options: KafkaMessageQueueOptions, deps?: ObservabilityDeps) {
    this.#kafka = new Kafka({ brokers: options.brokers });
    this.#deps = deps;
  }

  providePublisher(topic: string): Promise<Publisher> {
    if (topic === "") {
      return Promise.reject(ErrEmptyTopicName);
    }
    return this.#cache.getOrBuild(topic, () =>
      Promise.resolve(new KafkaPublisher(this.#kafka, topic, this.#deps)),
    );
  }

  // Ping checks connectivity by fetching cluster metadata from an admin client, mirroring Go's
  // broker dial.
  async ping(): Promise<void> {
    const admin = this.#kafka.admin();
    try {
      await admin.connect();
    } finally {
      await admin.disconnect();
    }
  }

  async close(): Promise<void> {
    const publishers = [...this.#cache.values()];
    this.#cache.clear();
    await Promise.allSettled(publishers.map(async (p) => (await p).stop()));
  }
}

class KafkaConsumer implements Consumer {
  readonly #reader: KafkaReader;
  readonly #topic: string;
  readonly #handler: ConsumerFunc;
  readonly #observer: Observer;
  readonly #instruments: ConsumerInstruments;
  #stopped = false;
  #resolveDone: (() => void) | undefined;

  constructor(
    kafka: Kafka,
    groupId: string,
    topic: string,
    handler: ConsumerFunc,
    deps?: ObservabilityDeps,
  ) {
    this.#reader = kafka.consumer({ groupId });
    this.#topic = topic;
    this.#handler = handler;
    this.#observer = deps?.observer ?? makeObserver(`${topic}_consumer`, deps);
    this.#instruments = consumerInstruments(deps, topic);
  }

  /** Tears down the reader and resolves any pending {@link consume}. Idempotent. */
  #stop(): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    this.#reader.disconnect().catch(() => undefined);
    this.#resolveDone?.();
  }

  async consume(signal?: AbortSignal, onError?: (err: unknown) => void): Promise<void> {
    if (signal?.aborted) {
      return;
    }

    const done = new Promise<void>((resolve) => {
      this.#resolveDone = resolve;
    });

    // Register the abort listener BEFORE any await so an abort during connect/subscribe/run is not
    // missed — otherwise the listener attaches too late and consume() hangs forever (LC-8).
    signal?.addEventListener(
      "abort",
      () => {
        this.#stop();
      },
      { once: true },
    );

    // Surface consumer death: a non-retriable crash otherwise halts delivery silently while
    // consume() stays pending and onError never fires (LC-9). Fatal crashes (no restart) also stop
    // so the caller's await resolves instead of hanging.
    this.#reader.on(this.#reader.events.CRASH, ({ payload }) => {
      onError?.(payload.error);
      if (!payload.restart) {
        this.#observer.logger().error("kafka consumer crashed (fatal)", payload.error, {
          topic: this.#topic,
        });
        this.#stop();
      }
    });
    this.#reader.on(this.#reader.events.DISCONNECT, () => {
      this.#observer
        .logger()
        .debug("kafka consumer disconnected", { topic: this.#topic });
    });

    // autoCommit is off so the offset advances only after the handler succeeds. On any failure we
    // rethrow out of eachMessage: kafkajs leaves the offset uncommitted and redelivers, rather than
    // letting a later message's commit advance past the failed one (silent loss). Redelivery is
    // unbounded here — a bounded-retry/dead-letter policy (kafkajs `retry` + a dead-letter
    // publisher) is a deliberate future seam.
    try {
      await this.#reader.connect();
      await this.#reader.subscribe({ topic: this.#topic, fromBeginning: false });
      await this.#reader.run({
        autoCommit: false,
        eachMessage: async ({ topic, partition, message }) => {
          const value = message.value ?? Buffer.alloc(0);
          await this.#observer.run("consume_message", async (op) => {
            op.set(TOPIC_KEY, topic).set(LENGTH_KEY, value.length);
            op.spanOnly("partition", partition).spanOnly("offset", message.offset);

            try {
              await this.#handler(new Uint8Array(value));
              this.#instruments.consumed.add(1);
            } catch (err) {
              this.#instruments.consumeErrors.add(1);
              onError?.(err);
              throw op.error(err, "handling message");
            }

            try {
              await this.#reader.commitOffsets([
                { topic, partition, offset: (Number(message.offset) + 1).toString() },
              ]);
            } catch (err) {
              onError?.(err);
              throw op.error(err, "committing message");
            }
          });
        },
      });
    } catch (err) {
      // connect/subscribe/run rejected (or an abort landed mid-setup) — surface and stop so the
      // caller isn't left awaiting a consume() that can never make progress.
      if (!this.#stopped) {
        onError?.(err);
      }
      this.#stop();
    }

    return done;
  }

  /** Disconnects the reader so provider.close() releases consumer-side broker connections. */
  async close(): Promise<void> {
    this.#stopped = true;
    this.#resolveDone?.();
    await this.#reader.disconnect().catch(() => undefined);
  }
}

/** A {@link ConsumerProvider} backed by Kafka. Faithful to Go's `kafka` consumer. */
export class KafkaConsumerProvider implements ConsumerProvider {
  readonly #kafka: Kafka;
  readonly #groupId: string;
  readonly #deps: ObservabilityDeps | undefined;
  readonly #cache = new TopicCache<KafkaConsumer>();

  constructor(options: KafkaMessageQueueOptions, deps?: ObservabilityDeps) {
    this.#kafka = new Kafka({ brokers: options.brokers });
    this.#groupId = options.groupId ?? "";
    this.#deps = deps;
  }

  provideConsumer(topic: string, handler: ConsumerFunc): Promise<Consumer> {
    if (topic === "") {
      return Promise.reject(ErrEmptyTopicName);
    }
    return this.#cache.getOrBuild(
      topic,
      () =>
        Promise.resolve(
          new KafkaConsumer(this.#kafka, this.#groupId, topic, handler, this.#deps),
        ),
      handler,
    );
  }

  async close(): Promise<void> {
    const consumers = [...this.#cache.values()];
    this.#cache.clear();
    await Promise.allSettled(consumers.map(async (c) => (await c).close()));
  }
}
