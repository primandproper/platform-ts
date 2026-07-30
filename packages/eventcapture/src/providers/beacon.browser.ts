import { PlatformError } from "@primandproper/errors";
import {
  ensureLogger,
  type Logger,
  type ObservabilityDeps,
} from "@primandproper/observability";

import {
  BeaconSinkConfigSchema,
  type BeaconSinkConfig,
  type BeaconSinkConfigInput,
} from "../config.js";
import type { Sink } from "../sink.js";

/** Raised when a record arrives after `close`. */
export const SINK_CLOSED_CODE = "eventcapture/sink-closed";
/** Raised when the collection endpoint answers with a non-2xx status. */
export const BEACON_REJECTED_CODE = "eventcapture/beacon-rejected";

/**
 * Batches records and POSTs them as a JSON array to a collection endpoint — durability as a
 * browser can offer it.
 *
 * Requests are sent with `keepalive`, so a batch already in flight survives the page going
 * away, and `close` prefers `navigator.sendBeacon`, which is the only send a browser promises
 * to finish during unload. Neither is a guarantee: a browser that discards the tail is exactly
 * why the recorder counts what it wrote.
 */
export class BeaconSink implements Sink {
  readonly #config: BeaconSinkConfig;
  readonly #logger: Logger;
  #pending: unknown[] = [];
  #closed = false;

  constructor(config: BeaconSinkConfigInput, deps?: ObservabilityDeps) {
    this.#config = BeaconSinkConfigSchema.parse(config);
    this.#logger = ensureLogger(deps?.logger).child("beacon_capture_sink");
  }

  /** Records batched but not yet sent. */
  get pending(): number {
    return this.#pending.length;
  }

  async write(record: unknown): Promise<void> {
    if (this.#closed) {
      throw new PlatformError(SINK_CLOSED_CODE, "beacon capture sink is closed");
    }
    this.#pending.push(record);
    if (this.#pending.length >= this.#config.maxBatch) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    const batch = this.#take();
    if (batch === undefined) {
      return;
    }

    const response = await fetch(this.#config.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.#config.headers },
      body: JSON.stringify(batch),
      keepalive: true,
    });
    if (!response.ok) {
      throw new PlatformError(
        BEACON_REJECTED_CODE,
        `capture endpoint answered ${String(response.status)}`,
      );
    }
  }

  /**
   * Sends whatever is left and stops accepting records. Uses `sendBeacon` when the browser has
   * it: during an unload a `fetch` may never be dispatched, and losing the tail on shutdown
   * defeats the point of capturing at all.
   */
  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    const batch = this.#take();
    this.#closed = true;
    if (batch === undefined) {
      return;
    }

    const body = JSON.stringify(batch);
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      // sendBeacon cannot carry custom headers; a collector that needs auth on the tail batch
      // has to accept it in the URL or the body, so say when we could not queue it at all.
      const queued = navigator.sendBeacon(
        this.#config.url,
        new Blob([body], { type: "application/json" }),
      );
      if (queued) {
        return;
      }
      this.#logger.warn(
        "browser refused the final capture beacon; falling back to fetch",
        {
          records: batch.length,
        },
      );
    }

    const response = await fetch(this.#config.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.#config.headers },
      body,
      keepalive: true,
    });
    if (!response.ok) {
      throw new PlatformError(
        BEACON_REJECTED_CODE,
        `capture endpoint answered ${String(response.status)}`,
      );
    }
  }

  /** Removes and returns the current batch, or `undefined` when there is nothing to send. */
  #take(): unknown[] | undefined {
    if (this.#pending.length === 0) {
      return undefined;
    }
    const batch = this.#pending;
    this.#pending = [];
    return batch;
  }
}
