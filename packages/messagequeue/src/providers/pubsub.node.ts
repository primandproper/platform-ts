import { type Message, PubSub, type Topic } from "@google-cloud/pubsub";
import {
  makeObserver,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

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

/** Pub/Sub config. Faithful to Go's `pubsub.Config`. */
export interface PubSubMessageQueueOptions {
  projectId: string;
}

/**
 * Derives a subscription name from a topic name. Mirrors Go's `subscriptionNameForTopic`: a fully
 * qualified `projects/{p}/topics/{t}` becomes `projects/{p}/subscriptions/{t}`, and a short topic
 * name is used verbatim as the subscription id.
 */
function subscriptionNameForTopic(topic: string): string {
  return topic.replace("/topics/", "/subscriptions/");
}

class PubSubPublisher implements Publisher {
  readonly #topic: Topic;
  readonly #topicName: string;
  readonly #observer: Observer;
  readonly #instruments: PublisherInstruments;

  constructor(topic: Topic, topicName: string, deps?: ObservabilityDeps) {
    this.#topic = topic;
    this.#topicName = topicName;
    this.#observer = makeObserver(`${topicName}_publisher`, deps);
    this.#instruments = publisherInstruments(deps, topicName);
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

      op.set(TOPIC_KEY, this.#topicName).set(LENGTH_KEY, bytes.length);

      const start = performance.now();
      let messageId: string;
      try {
        messageId = await this.#topic.publishMessage({ data: Buffer.from(bytes) });
      } catch (err) {
        this.#instruments.publishErrors.add(1);
        throw op.error(err, "publishing pubsub message");
      }

      op.spanOnly("message_id", messageId);
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
    // Flush any batched-but-unsent messages; mirrors Go's `pubSubPublisher.Stop`.
    this.#topic.flush().catch(() => undefined);
  }
}

/** A {@link PublisherProvider} backed by GCP Pub/Sub. Faithful to Go's `pubsub` publisher. */
export class PubSubPublisherProvider implements PublisherProvider {
  readonly #client: PubSub;
  readonly #deps: ObservabilityDeps | undefined;
  readonly #cache = new TopicCache<Publisher>();

  constructor(options: PubSubMessageQueueOptions, deps?: ObservabilityDeps) {
    this.#client = new PubSub({ projectId: options.projectId });
    this.#deps = deps;
  }

  providePublisher(topic: string): Promise<Publisher> {
    if (topic === "") {
      return Promise.reject(ErrEmptyTopicName);
    }
    return this.#cache.getOrBuild(topic, () =>
      Promise.resolve(new PubSubPublisher(this.#client.topic(topic), topic, this.#deps)),
    );
  }

  // Ping is a no-op for GCP Pub/Sub (managed service), mirroring Go.
  ping(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    this.#cache.clear();
    this.#client.close().catch(() => undefined);
  }
}

class PubSubConsumer implements Consumer {
  readonly #client: PubSub;
  readonly #topic: string;
  readonly #handler: ConsumerFunc;
  readonly #observer: Observer;
  readonly #consumed: ReturnType<typeof consumedCounter>;

  constructor(
    client: PubSub,
    topic: string,
    handler: ConsumerFunc,
    deps?: ObservabilityDeps,
  ) {
    this.#client = client;
    this.#topic = topic;
    this.#handler = handler;
    this.#observer = makeObserver(`${topic}_consumer`, deps);
    this.#consumed = consumedCounter(deps, topic);
  }

  async consume(signal?: AbortSignal, onError?: (err: unknown) => void): Promise<void> {
    if (signal?.aborted) {
      return;
    }

    const subscription = this.#client.subscription(subscriptionNameForTopic(this.#topic));

    subscription.on("message", (message: Message) => {
      void this.#deliver(message, onError);
    });
    subscription.on("error", (err: unknown) => {
      this.#observer.logger().error(`receiving ${this.#topic} pub/sub data`, err);
      onError?.(err);
    });

    return new Promise<void>((resolve) => {
      const stop = (): void => {
        subscription.close().catch(() => undefined);
        resolve();
      };
      signal?.addEventListener("abort", stop, { once: true });
    });
  }

  async #deliver(message: Message, onError?: (err: unknown) => void): Promise<void> {
    await this.#observer.run("consume_message", async (op) => {
      op.set(TOPIC_KEY, this.#topic).set(LENGTH_KEY, message.data.length);
      op.spanOnly("message_id", message.id).spanOnly(
        "delivery_attempt",
        message.deliveryAttempt,
      );
      this.#consumed.add(1);

      try {
        await this.#handler(new Uint8Array(message.data));
        message.ack();
      } catch (err) {
        op.acknowledge(err, "handling pubsub message");
        message.nack();
        onError?.(err);
      }
    });
  }
}

/** A {@link ConsumerProvider} backed by GCP Pub/Sub. Faithful to Go's `pubsub` consumer. */
export class PubSubConsumerProvider implements ConsumerProvider {
  readonly #client: PubSub;
  readonly #deps: ObservabilityDeps | undefined;
  readonly #cache = new TopicCache<Consumer>();

  constructor(options: PubSubMessageQueueOptions, deps?: ObservabilityDeps) {
    this.#client = new PubSub({ projectId: options.projectId });
    this.#deps = deps;
  }

  provideConsumer(topic: string, handler: ConsumerFunc): Promise<Consumer> {
    if (topic === "") {
      return Promise.reject(ErrEmptyTopicName);
    }
    return this.#cache.getOrBuild(topic, () =>
      Promise.resolve(new PubSubConsumer(this.#client, topic, handler, this.#deps)),
    );
  }
}
