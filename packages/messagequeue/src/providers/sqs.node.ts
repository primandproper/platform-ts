import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type SQSClientConfig,
} from "@aws-sdk/client-sqs";
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
  LENGTH_KEY,
  publisherInstruments,
  TOPIC_KEY,
  TopicCache,
  type PublisherInstruments,
} from "./support.js";

const LONG_POLL_WAIT_SECONDS = 20;
const MAX_NUMBER_OF_MESSAGES = 10;

/**
 * SQS config. Faithful to Go's `sqs.Config`, whose provider otherwise reads AWS credentials and
 * region from the ambient default chain. `region`/`endpoint`/`credentials` are exposed so a
 * caller (or a LocalStack test) can override that chain explicitly.
 */
export interface SQSMessageQueueOptions {
  region?: string | undefined;
  /** Override the SQS endpoint — e.g. a LocalStack URL for tests. */
  endpoint?: string | undefined;
  credentials?:
    | { accessKeyId: string; secretAccessKey: string; sessionToken?: string | undefined }
    | undefined;
}

function newClient(options: SQSMessageQueueOptions): SQSClient {
  const config: SQSClientConfig = {};
  if (options.region !== undefined) {
    config.region = options.region;
  }
  if (options.endpoint !== undefined) {
    config.endpoint = options.endpoint;
  }
  if (options.credentials !== undefined) {
    const { accessKeyId, secretAccessKey, sessionToken } = options.credentials;
    config.credentials = {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken === undefined ? {} : { sessionToken }),
    };
  }
  return new SQSClient(config);
}

class SQSPublisher implements Publisher {
  readonly #client: SQSClient;
  readonly #queueURL: string;
  readonly #observer: Observer;
  readonly #instruments: PublisherInstruments;

  constructor(client: SQSClient, queueURL: string, deps?: ObservabilityDeps) {
    this.#client = client;
    this.#queueURL = queueURL;
    this.#observer = makeObserver(`${queueURL}_publisher`, deps);
    this.#instruments = publisherInstruments(deps, queueURL);
  }

  async publish(data: unknown): Promise<void> {
    await this.#observer.run("publish", async (op) => {
      op.set(TOPIC_KEY, this.#queueURL);

      let body: string;
      try {
        body = JSON.stringify(data ?? null);
      } catch (err) {
        this.#instruments.publishErrors.add(1);
        throw op.error(err, "encoding topic message");
      }

      op.set(LENGTH_KEY, body.length);

      const start = performance.now();
      try {
        await this.#client.send(
          new SendMessageCommand({ QueueUrl: this.#queueURL, MessageBody: body }),
        );
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

  // SQS is a managed service with no per-publisher connection to release.
  stop(): void {}
}

/** A {@link PublisherProvider} backed by Amazon SQS. Faithful to Go's `sqs` publisher. */
export class SQSPublisherProvider implements PublisherProvider {
  readonly #client: SQSClient;
  readonly #deps: ObservabilityDeps | undefined;
  readonly #cache = new TopicCache<Publisher>();

  constructor(options: SQSMessageQueueOptions = {}, deps?: ObservabilityDeps) {
    this.#client = newClient(options);
    this.#deps = deps;
  }

  providePublisher(topic: string): Promise<Publisher> {
    if (topic === "") {
      return Promise.reject(ErrEmptyTopicName);
    }
    return this.#cache.getOrBuild(topic, () =>
      Promise.resolve(new SQSPublisher(this.#client, topic, this.#deps)),
    );
  }

  // Ping is a no-op for SQS (SQS is a managed service), mirroring Go.
  ping(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    this.#cache.clear();
    this.#client.destroy();
  }
}

class SQSConsumer implements Consumer {
  readonly #client: SQSClient;
  readonly #queueURL: string;
  readonly #handler: ConsumerFunc;
  readonly #observer: Observer;
  readonly #consumed: ReturnType<typeof consumedCounter>;

  constructor(
    client: SQSClient,
    queueURL: string,
    handler: ConsumerFunc,
    deps?: ObservabilityDeps,
  ) {
    this.#client = client;
    this.#queueURL = queueURL;
    this.#handler = handler;
    this.#observer = makeObserver(`${queueURL}_consumer`, deps);
    this.#consumed = consumedCounter(deps, queueURL);
  }

  /**
   * Long-polls the queue and processes messages until `signal` aborts. On handler success the
   * message is deleted; on failure it is left to reappear after its visibility timeout.
   */
  async consume(signal?: AbortSignal, onError?: (err: unknown) => void): Promise<void> {
    const aborted = (): boolean => signal?.aborted === true;

    for (;;) {
      if (aborted()) {
        return;
      }

      let messages;
      try {
        const output = await this.#client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.#queueURL,
            MaxNumberOfMessages: MAX_NUMBER_OF_MESSAGES,
            WaitTimeSeconds: LONG_POLL_WAIT_SECONDS,
          }),
          signal === undefined ? undefined : { abortSignal: signal },
        );
        messages = output.Messages ?? [];
      } catch (err) {
        if (aborted()) {
          return;
        }
        this.#observer.logger().error("receiving SQS messages", err);
        onError?.(err);
        continue;
      }

      for (const message of messages) {
        if (message.Body === undefined) {
          continue;
        }
        await this.#deliver(
          message.Body,
          message.ReceiptHandle,
          message.MessageId,
          onError,
        );
      }
    }
  }

  async #deliver(
    body: string,
    receiptHandle: string | undefined,
    messageId: string | undefined,
    onError?: (err: unknown) => void,
  ): Promise<void> {
    const bytes = new TextEncoder().encode(body);
    await this.#observer.run("consume_message", async (op) => {
      op.set(TOPIC_KEY, this.#queueURL).set(LENGTH_KEY, bytes.length);
      if (messageId !== undefined) {
        op.spanOnly("message_id", messageId);
      }
      this.#consumed.add(1);

      try {
        await this.#handler(bytes);
      } catch (err) {
        op.acknowledge(err, "handling SQS message");
        onError?.(err);
        return;
      }

      try {
        await this.#client.send(
          new DeleteMessageCommand({
            QueueUrl: this.#queueURL,
            ReceiptHandle: receiptHandle,
          }),
        );
      } catch (err) {
        op.acknowledge(err, "deleting SQS message");
        onError?.(err);
      }
    });
  }
}

/** A {@link ConsumerProvider} backed by Amazon SQS. Faithful to Go's `sqs` consumer. */
export class SQSConsumerProvider implements ConsumerProvider {
  readonly #client: SQSClient;
  readonly #deps: ObservabilityDeps | undefined;
  readonly #cache = new TopicCache<Consumer>();

  constructor(options: SQSMessageQueueOptions = {}, deps?: ObservabilityDeps) {
    this.#client = newClient(options);
    this.#deps = deps;
  }

  provideConsumer(topic: string, handler: ConsumerFunc): Promise<Consumer> {
    if (topic === "") {
      return Promise.reject(ErrEmptyTopicName);
    }
    return this.#cache.getOrBuild(topic, () =>
      Promise.resolve(new SQSConsumer(this.#client, topic, handler, this.#deps)),
    );
  }
}
