import apn from "@parse/node-apn";
import {
  makeObserver,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import { senderInstruments, type SenderInstruments } from "../support.js";

const o11yName = "ios_notif_sender";

/** Validates a 64-character hex string (32-byte token). Faithful to Go's regex. */
const apnsDeviceTokenHexPattern = /^[0-9a-fA-F]{64}$/;

/** APNs configuration. Faithful to Go's `apns.Config`. */
export interface ApnsConfig {
  /** Path to the `.p8` auth key file. */
  authKeyPath: string;
  keyID: string;
  teamID: string;
  /** The app's bundle identifier, used as the APNs topic. */
  bundleID: string;
  /** Production vs development APNs gateway. */
  production?: boolean;
}

/** The notification shape the {@link ApnsClient} seam accepts. */
export interface ApnsNotification {
  alert: { title: string; body: string };
  badge?: number;
  topic: string;
  priority: number;
}

/**
 * One device's outcome from a send. `@parse/node-apn` batches results into `sent`/`failed`;
 * a failed entry carries the APNs `status` and `response.reason`.
 */
export interface ApnsPushResult {
  sent: { device: string }[];
  failed: {
    device: string;
    status?: string | number;
    response?: { reason?: string } | null;
    error?: unknown;
  }[];
}

/**
 * The slice of the APNs SDK the sender depends on, extracted for testability — inject a fake to
 * unit-test without a real key or network. Go's seam is the `apns2.Client`; the TS SDK batches,
 * so the seam returns its `{sent, failed}` result.
 */
export interface ApnsClient {
  send(notification: ApnsNotification, deviceToken: string): Promise<ApnsPushResult>;
  /** Releases the underlying APNs connection pool. Optional so injected fakes need not implement it. */
  close?(): Promise<void>;
}

/** Builds an {@link ApnsClient} backed by the real `@parse/node-apn` provider. */
export function newApnsClient(config: ApnsConfig): ApnsClient {
  const provider = new apn.Provider({
    token: {
      key: config.authKeyPath,
      keyId: config.keyID,
      teamId: config.teamID,
    },
    production: config.production ?? false,
  });

  return {
    async send(notification, deviceToken) {
      const note = new apn.Notification();
      note.topic = notification.topic;
      note.priority = notification.priority;
      note.alert = notification.alert;
      if (notification.badge !== undefined) {
        note.badge = notification.badge;
      }
      return provider.send(note, deviceToken);
    },
    close() {
      // Drains and closes the APNs HTTP/2 connection pool so it stops pinning the event loop.
      return provider.shutdown();
    },
  };
}

/**
 * Sends push notifications to iOS devices via APNs. Faithful to Go's `apns.Sender`: it guards the
 * device-token format, sends at high priority, and records `status`/`reason` on failure. The
 * notification title is user content, so it is deliberately kept out of telemetry (INST-7).
 * `badgeCount`, when set, maps to `aps.badge`.
 */
export class ApnsSender {
  readonly #client: ApnsClient;
  readonly #topic: string;
  readonly #observer: Observer;
  readonly #instruments: SenderInstruments;

  constructor(client: ApnsClient, topic: string, deps?: ObservabilityDeps) {
    this.#client = client;
    this.#topic = topic;
    this.#observer = deps?.observer ?? makeObserver(o11yName, deps);
    this.#instruments = senderInstruments(o11yName, deps);
  }

  send(
    deviceToken: string,
    title: string,
    body: string,
    badgeCount?: number,
  ): Promise<void> {
    return this.#observer.run("send", async (op) => {
      if (!apnsDeviceTokenHexPattern.test(deviceToken)) {
        throw op.error(
          new Error(
            `apns: invalid device token format (expected 64 hex chars, got len ${String(deviceToken.length)})`,
          ),
          "validating device token",
        );
      }

      const notification: ApnsNotification = {
        alert: { title, body },
        topic: this.#topic,
        priority: 10,
      };
      if (badgeCount !== undefined) {
        notification.badge = badgeCount;
      }

      let result: ApnsPushResult;
      try {
        result = await this.#client.send(notification, deviceToken);
      } catch (err) {
        this.#instruments.errors.add(1);
        throw op.error(err, "apns: push failed");
      }

      const failure = result.failed[0];
      if (failure !== undefined) {
        this.#instruments.errors.add(1);
        const reason = failure.response?.reason ?? "unknown";
        op.set("statusCode", failure.status ?? "").set("reason", reason);
        throw op.error(
          new Error(`apns: ${reason} (status ${String(failure.status ?? "")})`),
          "sending apns notification",
        );
      }

      this.#instruments.sends.add(1);
    });
  }

  /** Releases the APNs connection pool. Idempotent; a no-op for a client without `close`. */
  async close(): Promise<void> {
    await this.#client.close?.();
  }
}
