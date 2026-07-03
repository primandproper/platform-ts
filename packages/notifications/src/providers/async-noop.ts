import type { AsyncNotifier } from "../async.js";

/** An {@link AsyncNotifier} that discards every event. Go's `async/noop`. */
export class NoopAsyncNotifier implements AsyncNotifier {
  publish(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {}
}
