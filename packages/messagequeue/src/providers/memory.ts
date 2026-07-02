import { randomUUID } from "node:crypto";

import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import type {
  Message,
  MessageHandler,
  MessageQueue,
  OutgoingMessage,
  Subscription,
} from "../messagequeue.js";

const o11yName = "messagequeue";

/**
 * An in-process pub/sub {@link MessageQueue}. `publish` fans out synchronously to every
 * subscriber of the topic and awaits each handler, so delivery is observable in the same
 * tick — ideal for tests and single-process apps. No cross-process or durable semantics.
 */
export class MemoryMessageQueue implements MessageQueue {
  readonly #handlers = new Map<string, Set<MessageHandler>>();
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(deps: ObservabilityDeps = {}) {
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  async publish(topic: string, message: OutgoingMessage): Promise<void> {
    const full: Message = {
      id: message.id ?? randomUUID(),
      body: message.body,
      ...(message.attributes === undefined ? {} : { attributes: message.attributes }),
    };

    const handlers = this.#handlers.get(topic);
    if (handlers === undefined || handlers.size === 0) {
      this.#logger.debug("no subscribers for topic");
      return;
    }

    for (const handler of [...handlers]) {
      await handler(full);
    }
  }

  subscribe(topic: string, handler: MessageHandler): Promise<Subscription> {
    let handlers = this.#handlers.get(topic);
    if (handlers === undefined) {
      handlers = new Set<MessageHandler>();
      this.#handlers.set(topic, handlers);
    }
    handlers.add(handler);

    const unsubscribe = (): Promise<void> => {
      const current = this.#handlers.get(topic);
      if (current !== undefined) {
        current.delete(handler);
        if (current.size === 0) {
          this.#handlers.delete(topic);
        }
      }
      return Promise.resolve();
    };

    return Promise.resolve({ unsubscribe });
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }
}
