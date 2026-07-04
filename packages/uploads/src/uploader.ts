import {
  provideCircuitBreaker,
  type CircuitBreaker,
} from "@primandproper/circuitbreaking";
import { PlatformError } from "@primandproper/errors";
import {
  makeMetrics,
  makeObserver,
  type Metrics,
  type ObservabilityDeps,
  type Observer,
  type Operation,
} from "@primandproper/observability";

import type { Bucket } from "./bucket.js";
import type {
  Attributer,
  Attributes,
  Lister,
  ObjectInfo,
  RangeReader,
  SignedURLOptions,
  URLSigner,
} from "./capabilities.js";
import type { UploadsConfig } from "./config.js";
import type { BlobBody } from "./stream.js";
import type { SaveOptions, UploadManager } from "./uploads.js";

type Counter = ReturnType<Metrics["counter"]>;
type Histogram = ReturnType<Metrics["histogram"]>;

/** Span/log attribute keys, mirroring Go's `observability/keys`. */
const FILENAME_KEY = "filename";
const LENGTH_KEY = "length";
const PREFIX_KEY = "prefix";
const OBJECT_COUNT_KEY = "object.count";

/**
 * Thrown when the circuit breaker is open, short-circuiting a doomed call. The port of Go's
 * `circuitbreaking.ErrCircuitBroken`, which the TS circuitbreaking package does not export.
 */
export const ErrCircuitBroken = new PlatformError(
  "uploads/circuit-broken",
  "circuit breaker is open",
);

/**
 * The instrumented {@link UploadManager}: a {@link Bucket} wrapped with a circuit breaker,
 * save/read/error counters, and a latency histogram, each observation fanning out to a span. It
 * also implements every optional capability the underlying bucket exposes ({@link RangeReader},
 * {@link URLSigner}, {@link Attributer}, {@link Lister}). The faithful analogue of platform-go's
 * `objectstorage.Uploader`.
 */
export class Uploader
  implements UploadManager, RangeReader, URLSigner, Attributer, Lister
{
  readonly #bucket: Bucket;
  readonly #observer: Observer;
  readonly #circuitBreaker: CircuitBreaker;
  readonly #saveCounter: Counter;
  readonly #readCounter: Counter;
  readonly #saveErrCounter: Counter;
  readonly #readErrCounter: Counter;
  readonly #latencyHist: Histogram;

  constructor(config: UploadsConfig, bucket: Bucket, deps: ObservabilityDeps = {}) {
    const serviceName = `${config.bucketName}_uploader`;
    this.#bucket = bucket;
    this.#observer = deps.observer ?? makeObserver(serviceName, deps);
    this.#circuitBreaker = provideCircuitBreaker(config.circuitBreaker, deps);

    const metrics = makeMetrics(serviceName, deps.metrics);
    this.#saveCounter = metrics.counter(`${serviceName}_saves`);
    this.#readCounter = metrics.counter(`${serviceName}_reads`);
    this.#saveErrCounter = metrics.counter(`${serviceName}_save_errors`);
    this.#readErrCounter = metrics.counter(`${serviceName}_read_errors`);
    this.#latencyHist = metrics.histogram(`${serviceName}_latency_ms`, { unit: "ms" });
  }

  save(path: string, body: BlobBody, opts?: SaveOptions): Promise<void> {
    return this.#track(
      "save",
      "save",
      "writing file content",
      (op) => {
        op.set(FILENAME_KEY, path);
        if (body instanceof Uint8Array) {
          op.set(LENGTH_KEY, body.length);
        }
      },
      () => this.#bucket.write(path, body, opts),
    );
  }

  open(path: string): Promise<ReadableStream<Uint8Array>> {
    return this.openRange(path, 0, -1);
  }

  openRange(
    path: string,
    offset: number,
    length: number,
  ): Promise<ReadableStream<Uint8Array>> {
    return this.#track(
      "openRange",
      "read",
      "opening object reader",
      (op) => op.set(FILENAME_KEY, path),
      () => this.#bucket.openRange(path, offset, length),
    );
  }

  delete(path: string): Promise<void> {
    return this.#track(
      "delete",
      "save",
      "deleting object",
      (op) => op.set(FILENAME_KEY, path),
      () => this.#bucket.delete(path),
    );
  }

  exists(path: string): Promise<boolean> {
    return this.#track(
      "exists",
      "read",
      "checking object existence",
      (op) => op.set(FILENAME_KEY, path),
      () => this.#bucket.exists(path),
    );
  }

  attributes(path: string): Promise<Attributes> {
    return this.#track(
      "attributes",
      "read",
      "fetching object attributes",
      (op) => op.set(FILENAME_KEY, path),
      () => this.#bucket.attributes(path),
    );
  }

  signedURL(path: string, opts?: SignedURLOptions): Promise<string> {
    return this.#track(
      "signedURL",
      "read",
      "signing object URL",
      (op) => op.set(FILENAME_KEY, path),
      () => this.#bucket.signedURL(path, opts),
    );
  }

  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    const op = this.#observer.begin("list");
    const start = performance.now();
    let count = 0;
    try {
      op.set(PREFIX_KEY, prefix);
      if (!this.#circuitBreaker.canProceed()) {
        throw ErrCircuitBroken;
      }
      try {
        for await (const obj of this.#bucket.list(prefix)) {
          count++;
          yield obj;
        }
      } catch (err) {
        this.#latencyHist.record(performance.now() - start);
        this.#readErrCounter.add(1);
        this.#circuitBreaker.failed();
        throw op.error(err, "listing objects");
      }
      op.set(OBJECT_COUNT_KEY, count);
      this.#latencyHist.record(performance.now() - start);
      this.#readCounter.add(1);
      this.#circuitBreaker.succeeded();
    } finally {
      op.end();
    }
  }

  /**
   * The shared instrument/breaker envelope every single-shot method runs inside: opens a span,
   * short-circuits when the breaker is open, times the delegate, and fans the outcome out to the
   * right counter pair (`save`/`read`) plus the latency histogram — the port of the repeated
   * bookkeeping in Go's `objectstorage/files.go`.
   */
  async #track<T>(
    name: string,
    kind: "save" | "read",
    failureDesc: string,
    setup: (op: Operation) => void,
    fn: () => Promise<T>,
  ): Promise<T> {
    const op = this.#observer.begin(name);
    try {
      setup(op);
      if (!this.#circuitBreaker.canProceed()) {
        throw ErrCircuitBroken;
      }
      const start = performance.now();
      try {
        const result = await fn();
        this.#latencyHist.record(performance.now() - start);
        (kind === "save" ? this.#saveCounter : this.#readCounter).add(1);
        this.#circuitBreaker.succeeded();
        return result;
      } catch (err) {
        this.#latencyHist.record(performance.now() - start);
        (kind === "save" ? this.#saveErrCounter : this.#readErrCounter).add(1);
        this.#circuitBreaker.failed();
        throw op.error(err, failureDesc);
      }
    } finally {
      op.end();
    }
  }
}
