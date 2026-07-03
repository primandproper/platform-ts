import {
  makeObserver,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";
import { Rest } from "ably";

import type { AsyncEvent, AsyncNotifier } from "../async.js";
import { senderInstruments, type SenderInstruments } from "../support.js";

const o11yName = "async_notifications_ably";

/** Ably async notifier config. Faithful to Go's `ably.Config`. */
export interface AblyAsyncNotifierOptions {
  apiKey: string;
}

/**
 * Abstracts Ably channel publishing for testability. Faithful to Go's `ChannelPublisher`
 * interface — inject a fake to unit-test without hitting the network.
 */
export interface ChannelPublisher {
  publish(channel: string, name: string, data: unknown): Promise<void>;
}

/** Builds a {@link ChannelPublisher} backed by the real Ably REST client. */
export function newChannelPublisher(options: AblyAsyncNotifierOptions): ChannelPublisher {
  const client = new Rest({ key: options.apiKey });
  return {
    publish: async (channel, name, data) => {
      await client.channels.get(channel).publish(name, data);
    },
  };
}

/** An Ably-backed {@link AsyncNotifier}. Faithful to Go's `ably.Notifier`. */
export class AblyAsyncNotifier implements AsyncNotifier {
  readonly #publisher: ChannelPublisher;
  readonly #observer: Observer;
  readonly #instruments: SenderInstruments;

  constructor(publisher: ChannelPublisher, deps?: ObservabilityDeps) {
    this.#publisher = publisher;
    this.#observer = deps?.observer ?? makeObserver(o11yName, deps);
    this.#instruments = senderInstruments(o11yName, deps);
  }

  publish(channel: string, event: AsyncEvent): Promise<void> {
    return this.#observer.run("publish", async (op) => {
      op.set("channel", channel).set("event.type", event.type);
      try {
        await this.#publisher.publish(channel, event.type, event.data);
      } catch (err) {
        this.#instruments.errors.add(1);
        throw op.error(err, "publishing to ably channel");
      }
      this.#instruments.sends.add(1);
    });
  }

  /** No-op: the Ably REST client holds no persistent connection. */
  close(): void {}
}
