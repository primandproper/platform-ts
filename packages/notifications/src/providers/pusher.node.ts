import {
  makeObserver,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";
import Pusher from "pusher";

import type { AsyncEvent, AsyncNotifier } from "../async.js";
import { senderInstruments, type SenderInstruments } from "../support.js";

const o11yName = "async_notifications_pusher";

/** Pusher async notifier config. Faithful to Go's `pusher.Config`. */
export interface PusherAsyncNotifierOptions {
  appID: string;
  key: string;
  secret: string;
  cluster: string;
  /** Whether to use TLS for the Pusher API connection. Go's `Secure`. */
  secure?: boolean;
}

/**
 * The slice of the Pusher SDK the notifier depends on, extracted for testability. Faithful to
 * Go's `PusherClient` interface — inject a fake to unit-test without hitting the network.
 */
export interface PusherClient {
  trigger(channel: string, eventName: string, data: unknown): Promise<unknown>;
}

/** Builds a {@link PusherClient} backed by the real `pusher` SDK. */
export function newPusherClient(options: PusherAsyncNotifierOptions): PusherClient {
  const client = new Pusher({
    appId: options.appID,
    key: options.key,
    secret: options.secret,
    cluster: options.cluster,
    useTLS: options.secure ?? true,
  });
  return {
    trigger: (channel, eventName, data) => client.trigger(channel, eventName, data),
  };
}

/** A Pusher-backed {@link AsyncNotifier}. Faithful to Go's `pusher.Notifier`. */
export class PusherAsyncNotifier implements AsyncNotifier {
  readonly #client: PusherClient;
  readonly #observer: Observer;
  readonly #instruments: SenderInstruments;

  constructor(client: PusherClient, deps?: ObservabilityDeps) {
    this.#client = client;
    this.#observer = deps?.observer ?? makeObserver(o11yName, deps);
    this.#instruments = senderInstruments(o11yName, deps);
  }

  publish(channel: string, event: AsyncEvent): Promise<void> {
    return this.#observer.run("publish", async (op) => {
      op.set("pusher.channel", channel).set("pusher.event_type", event.type);
      try {
        await this.#client.trigger(channel, event.type, event.data);
      } catch (err) {
        this.#instruments.errors.add(1);
        throw op.error(err, "publishing to pusher channel");
      }
      this.#instruments.sends.add(1);
    });
  }

  /** No-op: the Pusher notifier is a stateless HTTP client. */
  close(): void {}
}
