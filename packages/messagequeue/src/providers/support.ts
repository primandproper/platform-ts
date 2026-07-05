import {
  makeMetrics,
  type Metrics,
  type ObservabilityDeps,
} from "@primandproper/observability";

import { ErrConsumerHandlerMismatch } from "../messagequeue.js";

/** The name every provider registers its logger, tracer, and meter under. */
export const o11yName = "messagequeue";

type Counter = ReturnType<Metrics["counter"]>;
type Histogram = ReturnType<Metrics["histogram"]>;

/** Span/log attribute keys, mirroring Go's `observability/keys`. */
export const TOPIC_KEY = "topic";
export const LENGTH_KEY = "length";

/** The per-topic publish instruments Go mints in every `provide*Publisher`. */
export interface PublisherInstruments {
  published: Counter;
  publishErrors: Counter;
  latency: Histogram;
}

/** Builds the `{topic}_published` / `_publish_errors` / `_publish_latency_ms` instruments. */
export function publisherInstruments(
  deps: ObservabilityDeps | undefined,
  topic: string,
): PublisherInstruments {
  const metrics = makeMetrics(o11yName, deps?.metrics);
  return {
    published: metrics.counter(`${topic}_published`),
    publishErrors: metrics.counter(`${topic}_publish_errors`),
    latency: metrics.histogram(`${topic}_publish_latency_ms`, { unit: "ms" }),
  };
}

/** The per-topic consume instruments minted in every `provide*Consumer`. */
export interface ConsumerInstruments {
  /** Incremented once per message that the handler processed successfully. */
  consumed: Counter;
  /** Incremented once per message whose handler threw, so a failing consumer is visible. */
  consumeErrors: Counter;
}

/**
 * Builds the `{topic}_consumed` / `{topic}_consume_errors` counters. `consumed` counts only
 * *successful* handler runs and `consumeErrors` counts failures, so a 100%-failing consumer no
 * longer looks healthy the way a pre-handler increment made it (MQ-3).
 */
export function consumerInstruments(
  deps: ObservabilityDeps | undefined,
  topic: string,
): ConsumerInstruments {
  const metrics = makeMetrics(o11yName, deps?.metrics);
  return {
    consumed: metrics.counter(`${topic}_consumed`),
    consumeErrors: metrics.counter(`${topic}_consume_errors`),
  };
}

/**
 * JSON-encodes publish payloads to bytes — the analogue of Go's
 * `encoding.ProvideClientEncoder(ContentTypeJSON)`. Kept as bytes so every provider hands the
 * same wire form to its broker.
 */
export function encodeJSON(data: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(data ?? null));
}

/**
 * Per-topic cache shared by every provider. Go guards an identical `map[string]T` with a mutex;
 * JavaScript's single-threaded model makes the lock unnecessary, but concurrent async callers can
 * still race between the miss check and the insert, so the builder result is memoized as a promise
 * and awaited under one in-flight build per topic.
 */
export class TopicCache<T> {
  readonly #entries = new Map<string, Promise<T>>();
  // The identity a cached entry was built for (a consumer's handler). Lets a repeat call for the
  // same topic detect a *different* identity and reject rather than silently returning the first.
  readonly #identities = new Map<string, unknown>();

  /**
   * Returns the cached value for `topic`, building it on first use. When `identity` is given (the
   * consumer's handler), a later call for the same topic with a *different* identity rejects with
   * {@link ErrConsumerHandlerMismatch} instead of silently returning the original — see MQ-2.
   * Publishers omit `identity`, so they keep plain topic-keyed memoization.
   */
  async getOrBuild(
    topic: string,
    build: () => Promise<T>,
    identity?: unknown,
  ): Promise<T> {
    const existing = this.#entries.get(topic);
    if (existing !== undefined) {
      if (identity !== undefined && this.#identities.get(topic) !== identity) {
        throw ErrConsumerHandlerMismatch;
      }
      return existing;
    }
    const built = build();
    this.#entries.set(topic, built);
    if (identity !== undefined) {
      this.#identities.set(topic, identity);
    }
    try {
      return await built;
    } catch (err) {
      // A failed build must not poison the cache — drop it so the next call retries.
      this.#entries.delete(topic);
      this.#identities.delete(topic);
      throw err;
    }
  }

  values(): IterableIterator<Promise<T>> {
    return this.#entries.values();
  }

  clear(): void {
    this.#entries.clear();
    this.#identities.clear();
  }
}
