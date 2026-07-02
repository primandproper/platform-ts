import type { EventReporter } from "../analytics.js";

/** Universal reporter that discards everything. The safe default when analytics is off. */
export class NoopReporter implements EventReporter {
  track(): void {}

  identify(): void {}

  page(): void {}

  screen(): void {}

  flush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
