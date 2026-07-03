import { PlatformError } from "@primandproper/errors";

/**
 * Handles a single consumed message. Faithful to Go's
 * `ConsumerFunc func(context.Context, []byte) error`: it receives the raw payload bytes and
 * signals a handling error by rejecting/throwing (the analogue of Go's returned `error`).
 * The queue stays a dumb byte transport — callers own their own decoding.
 */
export type ConsumerFunc = (data: Uint8Array) => Promise<void>;

/**
 * Produces events onto a single topic. Obtained from {@link PublisherProvider.providePublisher};
 * a publisher is bound to the topic it was created for, exactly like Go's `Publisher`.
 */
export interface Publisher {
  /**
   * Writes a message onto the queue. `data` is JSON-encoded before it hits the wire, so callers
   * pass their own structs/objects rather than pre-serialized bytes — mirrors Go's
   * `Publish(ctx, data any) error`.
   */
  publish(data: unknown): Promise<void>;
  /**
   * Like {@link publish}, but errors are logged instead of surfaced — fire-and-forget. The
   * analogue of Go's `PublishAsync(ctx, data any)`.
   */
  publishAsync(data: unknown): void;
  /** Halts all publishing and releases any per-publisher resources. Go's `Stop()`. */
  stop(): void;
}

/**
 * Provides a {@link Publisher} for a given topic, caching one publisher per topic. The analogue
 * of Go's `PublisherProvider`.
 */
export interface PublisherProvider {
  /**
   * Returns the {@link Publisher} for `topic`, building and caching it on first use. Rejects with
   * {@link ErrEmptyTopicName} when `topic` is empty.
   */
  providePublisher(topic: string): Promise<Publisher>;
  /** Verifies the backing broker is reachable. Go's `Ping(ctx) error`. */
  ping(): Promise<void>;
  /** Closes the underlying client and every cached publisher. Go's `Close()`. */
  close(): void;
}

/**
 * Consumes events from a single topic. Obtained from {@link ConsumerProvider.provideConsumer}.
 * The analogue of Go's `Consumer`.
 */
export interface Consumer {
  /**
   * Delivers messages to the handler until `signal` aborts, resolving once consumption has fully
   * stopped. This is the idiomatic translation of Go's
   * `Consume(ctx, stopChan chan bool, errors chan error)`: the `signal` unifies Go's `ctx` and
   * `stopChan` (abort it to stop the loop), and `onError` receives errors raised while
   * consuming — the analogue of writing to Go's `errors` channel. With no `signal`, consumption
   * runs until the process exits, matching Go's nil-`stopChan` behaviour.
   */
  consume(signal?: AbortSignal, onError?: (err: unknown) => void): Promise<void>;
}

/**
 * Provides a {@link Consumer} for a given topic, caching one consumer per topic. The analogue of
 * Go's `ConsumerProvider`.
 */
export interface ConsumerProvider {
  /**
   * Returns the {@link Consumer} for `topic`, building and caching it on first use. Rejects with
   * {@link ErrEmptyTopicName} when `topic` is empty.
   */
  provideConsumer(topic: string, handler: ConsumerFunc): Promise<Consumer>;
}

/** Returned when a topic name is empty. Mirrors Go's `ErrEmptyTopicName`. */
export const ErrEmptyTopicName = new PlatformError(
  "messagequeue/empty-topic-name",
  "empty topic name",
);
