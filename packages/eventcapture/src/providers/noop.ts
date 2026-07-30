import type { Sink } from "../sink.js";

/** A sink that discards everything, for deployments with capture wired but disabled. */
export class NoopSink implements Sink {
  write(): Promise<void> {
    return Promise.resolve();
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
