import type {
  Consumer,
  ConsumerProvider,
  Publisher,
  PublisherProvider,
} from "../messagequeue.js";

/** A {@link Publisher} that discards every message. */
export class NoopPublisher implements Publisher {
  publish(): Promise<void> {
    return Promise.resolve();
  }

  publishAsync(): void {}

  stop(): void {}
}

/** A {@link PublisherProvider} that hands out {@link NoopPublisher}s. Go's `noop.publisherProvider`. */
export class NoopPublisherProvider implements PublisherProvider {
  providePublisher(): Promise<Publisher> {
    return Promise.resolve(new NoopPublisher());
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {}
}

/** A {@link Consumer} that never delivers anything and resolves only once aborted. */
export class NoopConsumer implements Consumer {
  consume(signal?: AbortSignal): Promise<void> {
    if (signal === undefined || signal.aborted) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      signal.addEventListener(
        "abort",
        () => {
          resolve();
        },
        { once: true },
      );
    });
  }
}

/** A {@link ConsumerProvider} that hands out {@link NoopConsumer}s. Go's `noop.consumerProvider`. */
export class NoopConsumerProvider implements ConsumerProvider {
  provideConsumer(): Promise<Consumer> {
    return Promise.resolve(new NoopConsumer());
  }
}
