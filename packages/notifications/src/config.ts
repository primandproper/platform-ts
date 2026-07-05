import { z } from "zod";

/** Pusher async notifier config. Faithful to Go's `pusher.Config`. */
export const PusherConfigSchema = z.object({
  appID: z.string().min(1),
  key: z.string().min(1),
  secret: z.string().min(1),
  cluster: z.string().min(1),
  /** Use TLS for the Pusher API connection. Secure by default; set `false` only for local dev. */
  secure: z.boolean().default(true),
});
export type PusherConfig = z.infer<typeof PusherConfigSchema>;

/** Ably async notifier config. Faithful to Go's `ably.Config`. */
export const AblyConfigSchema = z.object({
  apiKey: z.string().min(1),
});
export type AblyConfig = z.infer<typeof AblyConfigSchema>;

/**
 * Async-notifier providers. `pusher`, `ably`, and `noop` are implemented. `websocket` and `sse`
 * are accepted for parity with Go's provider set but are out of scope in platform-ts — they
 * require server-side connection management + HTTP upgrade, which the server framework owns (see
 * `ConnectionAcceptor`); the factory rejects them with a clear error.
 */
export const ASYNC_NOTIFIER_PROVIDERS = [
  "pusher",
  "ably",
  "websocket",
  "sse",
  "noop",
] as const;

/**
 * Selects and configures an {@link import("./async.js").AsyncNotifier}. Replaces the Go
 * `env:`-tagged `Config` + ozzo `ValidateWithContext`; the block for the selected provider is
 * required (mirrors Go's `validation.When`).
 */
export const AsyncNotifierConfigSchema = z
  .object({
    provider: z.enum(ASYNC_NOTIFIER_PROVIDERS).default("noop"),
    pusher: PusherConfigSchema.optional(),
    ably: AblyConfigSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    const required: Partial<Record<(typeof ASYNC_NOTIFIER_PROVIDERS)[number], unknown>> =
      {
        pusher: cfg.pusher,
        ably: cfg.ably,
      };
    if (cfg.provider in required && required[cfg.provider] === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [cfg.provider],
        message: `${cfg.provider} config is required when provider is '${cfg.provider}'`,
      });
    }
  });
export type AsyncNotifierConfig = z.infer<typeof AsyncNotifierConfigSchema>;
export type AsyncNotifierConfigInput = z.input<typeof AsyncNotifierConfigSchema>;

/** APNs config block for iOS push. Faithful to Go's mobile `APNsConfig`. */
export const ApnsConfigSchema = z.object({
  authKeyPath: z.string().min(1),
  keyID: z.string().min(1),
  teamID: z.string().min(1),
  bundleID: z.string().min(1),
  production: z.boolean().default(false),
});
export type ApnsConfigInput = z.input<typeof ApnsConfigSchema>;

/** FCM config block for Android push. Faithful to Go's mobile `FCMConfig`. */
export const FcmConfigSchema = z.object({
  /** Path to the Firebase service-account JSON file. Empty ⇒ Application Default Credentials. */
  credentialsPath: z.string().optional(),
});
export type FcmConfigInput = z.input<typeof FcmConfigSchema>;

/** Push-sender providers. `apns_fcm` wires the real senders; `noop` sends nothing. */
export const PUSH_SENDER_PROVIDERS = ["apns_fcm", "noop"] as const;

/**
 * Selects and configures a {@link import("./mobile.js").PushNotificationSender}. Faithful to Go's
 * mobile `Config`: under `apns_fcm`, each platform block is optional and initialized
 * independently — a missing or failing platform simply disables that platform.
 */
export const PushSenderConfigSchema = z.object({
  provider: z.enum(PUSH_SENDER_PROVIDERS).default("noop"),
  apns: ApnsConfigSchema.optional(),
  fcm: FcmConfigSchema.optional(),
});
export type PushSenderConfig = z.infer<typeof PushSenderConfigSchema>;
export type PushSenderConfigInput = z.input<typeof PushSenderConfigSchema>;
