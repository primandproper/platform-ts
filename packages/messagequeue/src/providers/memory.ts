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
  consumerInstruments,
  type ConsumerInstruments,
  encodeJSON,
  LENGTH_KEY,
  publisherInstruments,
  TOPIC_KEY,
  TopicCache,
  type PublisherInstruments,
} from "./support.js";

/**
 * An in-process pub/sub broker. Not present in platform-go — it exists so the same
 * {@link PublisherProvider}/{@link ConsumerProvider} contract runs with zero infrastructure in
 * tests and single-process apps. A publisher and consumer built against the *same* broker exchange
 * messages; the {@link provideMemoryPublisherProvider}/{@link provideMemoryConsumerProvider}
 * factories default to a shared module-level broker so the config-driven factory "just works".
 */
export class MemoryBroker {
  readonly #subscribers = new Map<string, Set<ConsumerFunc>>();

  subscribe(topic: string, handler: ConsumerFunc): () => void {
    let handlers = this.#subscribers.get(topic);
    if (handlers === undefined) {
      handlers = new Set<ConsumerFunc>();
      this.#subscribers.set(topic, handlers);
    }
    handlers.add(handler);

    return () => {
      const current = this.#subscribers.get(topic);
      if (current !== undefined) {
        current.delete(handler);
        if (current.size === 0) {
          this.#subscribers.delete(topic);
        }
      }
    };
  }

  async publish(topic: string, data: Uint8Array): Promise<void> {
    const handlers = this.#subscribers.get(topic);
    if (handlers === undefined) {
      return;
    }
    // Snapshot so a handler that (un)subscribes mid-fan-out doesn't mutate the live set.
    for (const handler of [...handlers]) {
      await handler(data);
    }
  }
}

/** The broker the factory wires when no explicit broker is supplied. */
const defaultBroker = new MemoryBroker();

class MemoryPublisher implements Publisher {
  readonly #broker: MemoryBroker;
  readonly #topic: string;
  readonly #observer: Observer;
  readonly #instruments: PublisherInstruments;

  constructor(broker: MemoryBroker, topic: string, deps?: ObservabilityDeps) {
    this.#broker = broker;
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
      await this.#broker.publish(this.#topic, bytes);
      this.#instruments.published.add(1);
    });
  }

  publishAsync(data: unknown): void {
    this.publish(data).catch((err: unknown) => {
      this.#observer.logger().error("publishing message", err);
    });
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}

/** A {@link PublisherProvider} backed by an in-process {@link MemoryBroker}. */
export class MemoryPublisherProvider implements PublisherProvider {
  readonly #broker: MemoryBroker;
  readonly #deps: ObservabilityDeps | undefined;
  readonly #cache = new TopicCache<Publisher>();

  constructor(broker: MemoryBroker = defaultBroker, deps?: ObservabilityDeps) {
    this.#broker = broker;
    this.#deps = deps;
  }

  providePublisher(topic: string): Promise<Publisher> {
    if (topic === "") {
      return Promise.reject(ErrEmptyTopicName);
    }
    return this.#cache.getOrBuild(topic, () =>
      Promise.resolve(new MemoryPublisher(this.#broker, topic, this.#deps)),
    );
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.#cache.clear();
    return Promise.resolve();
  }
}

class MemoryConsumer implements Consumer {
  readonly #broker: MemoryBroker;
  readonly #topic: string;
  readonly #handler: ConsumerFunc;
  readonly #observer: Observer;
  readonly #instruments: ConsumerInstruments;

  constructor(
    broker: MemoryBroker,
    topic: string,
    handler: ConsumerFunc,
    deps?: ObservabilityDeps,
  ) {
    this.#broker = broker;
    this.#topic = topic;
    this.#handler = handler;
    this.#observer = deps?.observer ?? makeObserver(`${topic}_consumer`, deps);
    this.#instruments = consumerInstruments(deps, topic);
  }

  consume(signal?: AbortSignal, onError?: (err: unknown) => void): Promise<void> {
    if (signal?.aborted) {
      return Promise.resolve();
    }

    const unsubscribe = this.#broker.subscribe(this.#topic, (data) =>
      this.#deliver(data, onError),
    );

    return new Promise<void>((resolve) => {
      const stop = (): void => {
        unsubscribe();
        resolve();
      };
      signal?.addEventListener("abort", stop, { once: true });
    });
  }

  async #deliver(data: Uint8Array, onError?: (err: unknown) => void): Promise<void> {
    await this.#observer.run("consume_message", async (op) => {
      op.set(TOPIC_KEY, this.#topic).set(LENGTH_KEY, data.length);
      try {
        await this.#handler(data);
        this.#instruments.consumed.add(1);
      } catch (err) {
        this.#instruments.consumeErrors.add(1);
        op.acknowledge(err, "handling message");
        onError?.(err);
      }
    });
  }
}

/** A {@link ConsumerProvider} backed by an in-process {@link MemoryBroker}. */
export class MemoryConsumerProvider implements ConsumerProvider {
  readonly #broker: MemoryBroker;
  readonly #deps: ObservabilityDeps | undefined;
  readonly #cache = new TopicCache<Consumer>();

  constructor(broker: MemoryBroker = defaultBroker, deps?: ObservabilityDeps) {
    this.#broker = broker;
    this.#deps = deps;
  }

  provideConsumer(topic: string, handler: ConsumerFunc): Promise<Consumer> {
    if (topic === "") {
      return Promise.reject(ErrEmptyTopicName);
    }
    return this.#cache.getOrBuild(
      topic,
      () => Promise.resolve(new MemoryConsumer(this.#broker, topic, handler, this.#deps)),
      handler,
    );
  }

  close(): Promise<void> {
    this.#cache.clear();
    return Promise.resolve();
  }
}

/** Builds a memory-backed {@link PublisherProvider}. Defaults to the shared module-level broker. */
export function provideMemoryPublisherProvider(
  deps?: ObservabilityDeps,
  broker?: MemoryBroker,
): PublisherProvider {
  return new MemoryPublisherProvider(broker ?? defaultBroker, deps);
}

/** Builds a memory-backed {@link ConsumerProvider}. Defaults to the shared module-level broker. */
export function provideMemoryConsumerProvider(
  deps?: ObservabilityDeps,
  broker?: MemoryBroker,
): ConsumerProvider {
  return new MemoryConsumerProvider(broker ?? defaultBroker, deps);
}
