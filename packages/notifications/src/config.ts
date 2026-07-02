import { z } from "zod";

/** Validated shape of an inbound notification frame. `payload` stays opaque (`unknown`). */
export const NotificationSchema = z.object({
  id: z.string(),
  channel: z.string(),
  type: z.string(),
  payload: z.unknown(),
  sentAt: z.number().optional(),
});

export const WebSocketOptionsSchema = z.object({
  url: z.string().url(),
});

export type WebSocketOptionsConfig = z.infer<typeof WebSocketOptionsSchema>;

/**
 * Notifications config. The provider set is identical on Node and the browser — the
 * websocket provider stays universal via an injectable socket — so call-site code is
 * portable. Replaces the Go platform's `env:`-tagged struct + ozzo `ValidateWithContext`.
 */
export const NotificationConfigSchema = z
  .object({
    provider: z.enum(["websocket", "memory", "noop"]).default("memory"),
    websocket: WebSocketOptionsSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.provider === "websocket" && cfg.websocket === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["websocket"],
        message: "websocket config is required when provider is 'websocket'",
      });
    }
  });

export type NotificationConfig = z.infer<typeof NotificationConfigSchema>;
export type NotificationConfigInput = z.input<typeof NotificationConfigSchema>;
