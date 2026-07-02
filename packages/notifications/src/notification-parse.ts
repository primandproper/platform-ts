import { NotificationSchema } from "./config.js";
import type { Notification } from "./notifications.js";

/**
 * Parses a raw inbound frame into a {@link Notification}. Accepts a JSON string (the common
 * `WebSocket` `message` payload) or an already-decoded object, validates it against
 * {@link NotificationSchema}, and returns `undefined` for anything malformed so callers can
 * drop bad frames without throwing.
 */
export function parseNotification(data: unknown): Notification | undefined {
  let value: unknown = data;
  if (typeof data === "string") {
    try {
      value = JSON.parse(data);
    } catch {
      return undefined;
    }
  }
  const result = NotificationSchema.safeParse(value);
  if (!result.success) {
    return undefined;
  }
  const { id, channel, type, payload, sentAt } = result.data;
  const notification: Notification = { id, channel, type, payload };
  if (sentAt !== undefined) {
    notification.sentAt = sentAt;
  }
  return notification;
}
