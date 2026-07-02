import type { MessageQueue, Subscription } from "../messagequeue.js";

/** A {@link MessageQueue} that discards every publish and never delivers anything. */
export class NoopMessageQueue implements MessageQueue {
  publish(): Promise<void> {
    return Promise.resolve();
  }

  subscribe(): Promise<Subscription> {
    return Promise.resolve({ unsubscribe: () => Promise.resolve() });
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }
}
