import {
  makeObserver,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";
import { applicationDefault, cert, deleteApp, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";

import { senderInstruments, type SenderInstruments } from "../support.js";

const o11yName = "android_notif_sender";

/** Distinguishes each initialized Firebase app so repeated factory calls don't collide. */
let appCounter = 0;

/** FCM configuration. Faithful to Go's `fcm.Config`. */
export interface FcmConfig {
  /**
   * Path to the Firebase service-account JSON file. When empty, Application Default Credentials
   * (ADC) are used.
   */
  credentialsPath?: string | undefined;
}

/** The message shape the {@link FcmClient} seam accepts. */
export interface FcmMessage {
  token: string;
  notification: { title: string; body: string };
}

/**
 * The slice of the FCM SDK the sender depends on, extracted for testability — inject a fake to
 * unit-test without real credentials. `send` resolves to the FCM message id.
 */
export interface FcmClient {
  send(message: FcmMessage): Promise<string>;
  /** Deletes the underlying Firebase app. Optional so injected fakes need not implement it. */
  close?(): Promise<void>;
}

/** Builds an {@link FcmClient} backed by the real `firebase-admin` messaging client. */
export function newFcmClient(config: FcmConfig): FcmClient {
  const credential =
    config.credentialsPath !== undefined && config.credentialsPath !== ""
      ? cert(config.credentialsPath)
      : applicationDefault();

  appCounter += 1;
  const app = initializeApp({ credential }, `notifications-fcm-${String(appCounter)}`);
  const messaging = getMessaging(app);

  return {
    send: (message) => messaging.send(message),
    // Deletes the initialized app so its background work stops keeping the process alive.
    close: () => deleteApp(app),
  };
}

/**
 * Sends push notifications to Android devices via FCM. Faithful to Go's `fcm.Sender`: it records
 * the returned `fcm.message_id`. The notification title is user content, so it is deliberately
 * kept out of telemetry (INST-7).
 */
export class FcmSender {
  readonly #client: FcmClient;
  readonly #observer: Observer;
  readonly #instruments: SenderInstruments;

  constructor(client: FcmClient, deps?: ObservabilityDeps) {
    this.#client = client;
    this.#observer = deps?.observer ?? makeObserver(o11yName, deps);
    this.#instruments = senderInstruments(o11yName, deps);
  }

  send(deviceToken: string, title: string, body: string): Promise<void> {
    return this.#observer.run("send", async (op) => {
      let messageID: string;
      try {
        messageID = await this.#client.send({
          token: deviceToken,
          notification: { title, body },
        });
      } catch (err) {
        this.#instruments.errors.add(1);
        throw op.error(err, "sending fcm message");
      }

      op.set("fcm.message_id", messageID);
      this.#instruments.sends.add(1);
    });
  }

  /** Deletes the backing Firebase app. Idempotent; a no-op for a client without `close`. */
  async close(): Promise<void> {
    await this.#client.close?.();
  }
}
