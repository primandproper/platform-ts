import {
  makeMetrics,
  type Metrics,
  type ObservabilityDeps,
} from "@primandproper/observability";

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

/** Builds the `{topic}_consumed` counter Go mints in every `provide*Consumer`. */
export function consumedCounter(
  deps: ObservabilityDeps | undefined,
  topic: string,
): Counter {
  return makeMetrics(o11yName, deps?.metrics).counter(`${topic}_consumed`);
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

  async getOrBuild(topic: string, build: () => Promise<T>): Promise<T> {
    const existing = this.#entries.get(topic);
    if (existing !== undefined) {
      return existing;
    }
    const built = build();
    this.#entries.set(topic, built);
    try {
      return await built;
    } catch (err) {
      // A failed build must not poison the cache — drop it so the next call retries.
      this.#entries.delete(topic);
      throw err;
    }
  }

  values(): IterableIterator<Promise<T>> {
    return this.#entries.values();
  }

  clear(): void {
    this.#entries.clear();
  }
}
