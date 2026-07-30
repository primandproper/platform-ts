/**
 * Persists captured records. Calls arrive from the {@link Recorder}'s single drain chain — one
 * at a time, never concurrently — so implementations need no locking between `write` and
 * `flush`; `close` may still race a caller-initiated `flush`, so guard that.
 *
 * `write` receives whatever record types the composition emits — raw events, transformed wire
 * shapes, aggregate rollups — and must not retain the value past the call.
 *
 * Every method may reject: the {@link Recorder} counts and logs sink failures and never
 * surfaces them to whoever called `record`.
 */
export interface Sink {
  /** Appends one record. */
  write(record: unknown): Promise<void>;
  /**
   * Pushes buffered records toward durable storage. The recorder calls it on every tick, so a
   * `tail -f` of a file sink stays current.
   */
  flush(): Promise<void>;
  /** Flushes and releases resources. The sink is unusable afterwards. */
  close(): Promise<void>;
}
