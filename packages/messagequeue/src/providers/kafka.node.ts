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
  consumedCounter,
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
    this.#observer = makeObserver(`${topic}_publisher`, deps);
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

  stop(): void {
    if (this.#connected !== undefined) {
      this.#producer.disconnect().catch((err: unknown) => {
        this.#observer.logger().error("closing kafka producer", err);
      });
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

  close(): void {
    for (const pub of this.#cache.values()) {
      pub
        .then((p) => {
          p.stop();
        })
        .catch(() => undefined);
    }
    this.#cache.clear();
  }
}

class KafkaConsumer implements Consumer {
  readonly #reader: KafkaReader;
  readonly #topic: string;
  readonly #handler: ConsumerFunc;
  readonly #observer: Observer;
  readonly #consumed: ReturnType<typeof consumedCounter>;

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
    this.#observer = makeObserver(`${topic}_consumer`, deps);
    this.#consumed = consumedCounter(deps, topic);
  }

  async consume(signal?: AbortSignal, onError?: (err: unknown) => void): Promise<void> {
    if (signal?.aborted) {
      return;
    }

    await this.#reader.connect();
    await this.#reader.subscribe({ topic: this.#topic, fromBeginning: false });

    // autoCommit is off so the offset advances only after the handler succeeds — a failed handler
    // leaves the message uncommitted for redelivery, mirroring Go's fetch-then-commit flow.
    await this.#reader.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }) => {
        const value = message.value ?? Buffer.alloc(0);
        await this.#observer.run("consume_message", async (op) => {
          op.set(TOPIC_KEY, topic).set(LENGTH_KEY, value.length);
          op.spanOnly("partition", partition).spanOnly("offset", message.offset);
          this.#consumed.add(1);

          try {
            await this.#handler(new Uint8Array(value));
          } catch (err) {
            op.acknowledge(err, "handling message");
            onError?.(err);
            return;
          }

          try {
            await this.#reader.commitOffsets([
              { topic, partition, offset: (Number(message.offset) + 1).toString() },
            ]);
          } catch (err) {
            op.acknowledge(err, "committing message");
            onError?.(err);
          }
        });
      },
    });

    return new Promise<void>((resolve) => {
      const stop = (): void => {
        this.#reader.disconnect().catch(() => undefined);
        resolve();
      };
      signal?.addEventListener("abort", stop, { once: true });
    });
  }
}

/** A {@link ConsumerProvider} backed by Kafka. Faithful to Go's `kafka` consumer. */
export class KafkaConsumerProvider implements ConsumerProvider {
  readonly #kafka: Kafka;
  readonly #groupId: string;
  readonly #deps: ObservabilityDeps | undefined;
  readonly #cache = new TopicCache<Consumer>();

  constructor(options: KafkaMessageQueueOptions, deps?: ObservabilityDeps) {
    this.#kafka = new Kafka({ brokers: options.brokers });
    this.#groupId = options.groupId ?? "";
    this.#deps = deps;
  }

  provideConsumer(topic: string, handler: ConsumerFunc): Promise<Consumer> {
    if (topic === "") {
      return Promise.reject(ErrEmptyTopicName);
    }
    return this.#cache.getOrBuild(topic, () =>
      Promise.resolve(
        new KafkaConsumer(this.#kafka, this.#groupId, topic, handler, this.#deps),
      ),
    );
  }
}
