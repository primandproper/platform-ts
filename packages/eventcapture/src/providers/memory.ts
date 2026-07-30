import { PlatformError } from "@primandproper/errors";

import type { Sink } from "../sink.js";

/** Raised by {@link InMemorySink} when a record arrives after `close`. */
export const SINK_CLOSED_CODE = "eventcapture/sink-closed";

/**
 * Keeps every record in memory. The conformance-test sink: it is the only implementation whose
 * writes can be asserted directly, so it is what proves the recorder's contract (drop counting,
 * transform, tail flush) independent of any real backend.
 *
 * Records accumulate without bound — that is the point in a test, and the reason this is not a
 * production sink.
 */
export class InMemorySink implements Sink {
  readonly #records: unknown[] = [];
  #flushes = 0;
  #closed = false;

  /** Everything written so far, in write order. */
  get records(): readonly unknown[] {
    return this.#records;
  }

  /** How many times `flush` has been called. */
  get flushes(): number {
    return this.#flushes;
  }

  /** Whether `close` has been called. */
  get closed(): boolean {
    return this.#closed;
  }

  async write(record: unknown): Promise<void> {
    if (this.#closed) {
      throw new PlatformError(SINK_CLOSED_CODE, "in-memory capture sink is closed");
    }
    this.#records.push(record);
  }

  async flush(): Promise<void> {
    this.#flushes++;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
