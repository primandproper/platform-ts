import {
  makeRecordingObserver,
  type MeterProvider,
  type ObservabilityDeps,
} from "@primandproper/observability";
import { describe, expect, it, vi } from "vitest";

import {
  AblyAsyncNotifier,
  ApnsSender,
  type ApnsClient,
  type AsyncNotifier,
  type ChannelPublisher,
  ErrPlatformNotSupported,
  FcmSender,
  type FcmClient,
  MultiPlatformPushSender,
  NoopAsyncNotifier,
  NoopPushNotificationSender,
  provideAsyncNotifier,
  providePushSender,
  type PushNotificationSender,
  PusherAsyncNotifier,
  type PusherClient,
} from "./index.js";

/** A MeterProvider that records every counter `add`, so tests can assert send/error counters. */
function countingMeter(): { deps: ObservabilityDeps; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const meter = {
    createCounter: (name: string) => ({
      add: (value: number) => counts.set(name, (counts.get(name) ?? 0) + value),
    }),
    // makeObserver auto-mints an operation-duration histogram (OBS-1); the fake meter must
    // provide it even though these tests only assert on the counters.
    createHistogram: () => ({ record: () => undefined }),
    createUpDownCounter: () => ({ add: () => undefined }),
    createGauge: () => ({ record: () => undefined }),
  };
  const provider = { getMeter: () => meter } as unknown as MeterProvider;
  return { deps: { metrics: provider }, counts };
}

describe("PusherAsyncNotifier", () => {
  it("triggers the channel with the event type and data, counting the send", async () => {
    const trigger = vi.fn<PusherClient["trigger"]>().mockResolvedValue(undefined);
    const { deps, counts } = countingMeter();

    const notifier = new PusherAsyncNotifier({ trigger }, deps);
    await notifier.publish("room-1", { type: "message", data: { hello: "world" } });

    expect(trigger).toHaveBeenCalledWith("room-1", "message", { hello: "world" });
    expect(counts.get("async_notifications_pusher_sends")).toBe(1);
    notifier.close();
  });

  it("surfaces a trigger failure through the operation and counts the error", async () => {
    const boom = new Error("pusher down");
    const observer = makeRecordingObserver();
    const { deps, counts } = countingMeter();

    const notifier = new PusherAsyncNotifier(
      { trigger: () => Promise.reject(boom) },
      { ...deps, observer },
    );

    await expect(notifier.publish("room-1", { type: "message" })).rejects.toBe(boom);
    expect(counts.get("async_notifications_pusher_errors")).toBe(1);
    expect(observer.errors.map((e) => e.description)).toContain(
      "publishing to pusher channel",
    );
  });
});

describe("AblyAsyncNotifier", () => {
  it("publishes the event name and data to the channel", async () => {
    const publish = vi.fn<ChannelPublisher["publish"]>().mockResolvedValue(undefined);
    const { deps, counts } = countingMeter();

    const notifier = new AblyAsyncNotifier({ publish }, deps);
    await notifier.publish("chan", { type: "tick", data: 42 });

    expect(publish).toHaveBeenCalledWith("chan", "tick", 42);
    expect(counts.get("async_notifications_ably_sends")).toBe(1);
  });

  it("surfaces a publish failure and counts the error", async () => {
    const boom = new Error("ably down");
    const { deps, counts } = countingMeter();
    const notifier = new AblyAsyncNotifier({ publish: () => Promise.reject(boom) }, deps);

    await expect(notifier.publish("chan", { type: "tick" })).rejects.toBe(boom);
    expect(counts.get("async_notifications_ably_errors")).toBe(1);
  });
});

describe("ApnsSender", () => {
  const validToken = "a".repeat(64);

  it("sends an alert to a valid device token, counting the send", async () => {
    const send = vi
      .fn<ApnsClient["send"]>()
      .mockResolvedValue({ sent: [{ device: validToken }], failed: [] });
    const { deps, counts } = countingMeter();

    const sender = new ApnsSender({ send }, "com.example.app", deps);
    await sender.send(validToken, "Title", "Body", 3);

    expect(send).toHaveBeenCalledWith(
      {
        alert: { title: "Title", body: "Body" },
        badge: 3,
        topic: "com.example.app",
        priority: 10,
      },
      validToken,
    );
    expect(counts.get("ios_notif_sender_sends")).toBe(1);
  });

  it("rejects a malformed device token before calling the client", async () => {
    const send = vi.fn<ApnsClient["send"]>();
    const sender = new ApnsSender({ send }, "com.example.app");

    await expect(sender.send("not-hex", "T", "B")).rejects.toThrow(
      /invalid device token/,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("errors and counts when APNs reports the token failed", async () => {
    const send = vi.fn<ApnsClient["send"]>().mockResolvedValue({
      sent: [],
      failed: [{ device: validToken, status: 410, response: { reason: "Unregistered" } }],
    });
    const { deps, counts } = countingMeter();
    const sender = new ApnsSender({ send }, "com.example.app", deps);

    await expect(sender.send(validToken, "T", "B")).rejects.toThrow(/Unregistered/);
    expect(counts.get("ios_notif_sender_errors")).toBe(1);
  });
});

describe("FcmSender", () => {
  it("sends a notification and records the message id", async () => {
    const send = vi.fn<FcmClient["send"]>().mockResolvedValue("projects/x/messages/1");
    const { deps, counts } = countingMeter();

    const sender = new FcmSender({ send }, deps);
    await sender.send("device-token", "Title", "Body");

    expect(send).toHaveBeenCalledWith({
      token: "device-token",
      notification: { title: "Title", body: "Body" },
    });
    expect(counts.get("android_notif_sender_sends")).toBe(1);
  });

  it("surfaces a send failure and counts the error", async () => {
    const boom = new Error("fcm down");
    const { deps, counts } = countingMeter();
    const sender = new FcmSender({ send: () => Promise.reject(boom) }, deps);

    await expect(sender.send("device-token", "T", "B")).rejects.toBe(boom);
    expect(counts.get("android_notif_sender_errors")).toBe(1);
  });
});

describe("MultiPlatformPushSender", () => {
  const iosToken = "b".repeat(64);

  function build(opts: { apns?: boolean; fcm?: boolean }): {
    sender: MultiPlatformPushSender;
    apnsSend: ReturnType<typeof vi.fn<ApnsClient["send"]>>;
    fcmSend: ReturnType<typeof vi.fn<FcmClient["send"]>>;
  } {
    const apnsSend = vi
      .fn<ApnsClient["send"]>()
      .mockResolvedValue({ sent: [{ device: iosToken }], failed: [] });
    const fcmSend = vi.fn<FcmClient["send"]>().mockResolvedValue("msg-1");
    const apnsSender = opts.apns
      ? new ApnsSender({ send: apnsSend }, "com.example.app")
      : undefined;
    const fcmSender = opts.fcm ? new FcmSender({ send: fcmSend }) : undefined;
    return {
      sender: new MultiPlatformPushSender(apnsSender, fcmSender),
      apnsSend,
      fcmSend,
    };
  }

  it("routes iOS (case-insensitive) to APNs and Android to FCM", async () => {
    const { sender, apnsSend, fcmSend } = build({ apns: true, fcm: true });

    await sender.sendPush("iOS", iosToken, { title: "T", body: "B" });
    await sender.sendPush("android", "android-token", { title: "T", body: "B" });

    expect(apnsSend).toHaveBeenCalledTimes(1);
    expect(fcmSend).toHaveBeenCalledTimes(1);
  });

  it("rejects with ErrPlatformNotSupported when the platform sender is absent", async () => {
    const { sender } = build({ fcm: true });
    await expect(
      sender.sendPush("ios", iosToken, { title: "T", body: "B" }),
    ).rejects.toBe(ErrPlatformNotSupported);
  });

  it("rejects an unknown platform", async () => {
    const { sender } = build({ apns: true, fcm: true });
    await expect(
      sender.sendPush("blackberry", "token", { title: "T", body: "B" }),
    ).rejects.toThrow(/unknown platform/);
  });
});

describe("noop providers", () => {
  it("NoopAsyncNotifier publishes and closes without throwing", async () => {
    const notifier: AsyncNotifier = new NoopAsyncNotifier();
    await expect(notifier.publish("c", { type: "t" })).resolves.toBeUndefined();
    expect(() => {
      notifier.close();
    }).not.toThrow();
  });

  it("NoopPushNotificationSender sends without throwing", async () => {
    const sender: PushNotificationSender = new NoopPushNotificationSender();
    await expect(
      sender.sendPush("ios", "token", { title: "T", body: "B" }),
    ).resolves.toBeUndefined();
  });
});

describe("provideAsyncNotifier", () => {
  it("defaults to a noop notifier", () => {
    expect(provideAsyncNotifier()).toBeInstanceOf(NoopAsyncNotifier);
  });

  it("requires the pusher block when provider is pusher", () => {
    expect(() => provideAsyncNotifier({ provider: "pusher" })).toThrow(
      /pusher config is required/,
    );
  });

  it("builds a pusher notifier from a valid config", () => {
    const notifier = provideAsyncNotifier({
      provider: "pusher",
      pusher: { appID: "1", key: "k", secret: "s", cluster: "us1" },
    });
    expect(notifier).toBeInstanceOf(PusherAsyncNotifier);
  });

  it("builds an ably notifier from a valid config", () => {
    const notifier = provideAsyncNotifier({ provider: "ably", ably: { apiKey: "x:y" } });
    expect(notifier).toBeInstanceOf(AblyAsyncNotifier);
  });

  it("rejects the out-of-scope websocket/sse providers", () => {
    expect(() => provideAsyncNotifier({ provider: "websocket" })).toThrow(
      /not implemented/,
    );
    expect(() => provideAsyncNotifier({ provider: "sse" })).toThrow(/not implemented/);
  });
});

describe("providePushSender", () => {
  it("defaults to a noop sender", () => {
    expect(providePushSender()).toBeInstanceOf(NoopPushNotificationSender);
  });

  it("falls back to noop under apns_fcm when neither platform is configured", () => {
    expect(providePushSender({ provider: "apns_fcm" })).toBeInstanceOf(
      NoopPushNotificationSender,
    );
  });
});
