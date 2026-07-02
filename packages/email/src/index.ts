import type { ObservabilityDeps } from "@primandproper/observability";

import { EmailConfigSchema, type EmailConfigInput } from "./config.js";
import type { Email } from "./email.js";
import { MailgunEmail } from "./providers/mailgun.js";
import { MailjetEmail } from "./providers/mailjet.js";
import { MemoryEmail } from "./providers/memory.js";
import { NoopEmail } from "./providers/noop.js";
import { PostmarkEmail } from "./providers/postmark.node.js";
import { ResendEmail } from "./providers/resend.js";
import { SendgridEmail } from "./providers/sendgrid.js";

export * from "./email.js";
export * from "./config.js";
export { NoopEmail } from "./providers/noop.js";
export { MemoryEmail } from "./providers/memory.js";
export type { FetchLike } from "./providers/http.js";
export { ResendEmail, type ResendEmailOptions } from "./providers/resend.js";
export {
  PostmarkEmail,
  type PostmarkEmailOptions,
  type PostmarkClientLike,
  type PostmarkMessage,
  type PostmarkSendResponse,
} from "./providers/postmark.node.js";
export { SendgridEmail, type SendgridEmailOptions } from "./providers/sendgrid.js";
export { MailgunEmail, type MailgunEmailOptions } from "./providers/mailgun.js";
export { MailjetEmail, type MailjetEmailOptions } from "./providers/mailjet.js";

/**
 * Validates config and returns the matching {@link Email}. Mirrors the Go platform's
 * `ProvideEmailer`. Supports `noop` (default), `memory`, `resend`, `postmark`, `sendgrid`,
 * `mailgun`, and `mailjet`.
 */
export function provideEmail(config?: EmailConfigInput, deps?: ObservabilityDeps): Email {
  const cfg = EmailConfigSchema.parse(config ?? {});
  switch (cfg.provider) {
    case "noop":
      return new NoopEmail(deps);
    case "memory":
      return new MemoryEmail();
    case "resend":
      // superRefine guarantees this, but narrow for the type checker.
      if (cfg.resend === undefined) {
        throw new Error("resend config is required when provider is 'resend'");
      }
      return new ResendEmail(
        { apiKey: cfg.resend.apiKey, baseUrl: cfg.resend.baseUrl },
        deps,
      );
    case "postmark":
      // superRefine guarantees this, but narrow for the type checker.
      if (cfg.postmark === undefined) {
        throw new Error("postmark config is required when provider is 'postmark'");
      }
      return new PostmarkEmail({ serverToken: cfg.postmark.serverToken }, deps);
    case "sendgrid":
      if (cfg.sendgrid === undefined) {
        throw new Error("sendgrid config is required when provider is 'sendgrid'");
      }
      return new SendgridEmail(
        { apiKey: cfg.sendgrid.apiKey, baseUrl: cfg.sendgrid.baseUrl },
        deps,
      );
    case "mailgun":
      if (cfg.mailgun === undefined) {
        throw new Error("mailgun config is required when provider is 'mailgun'");
      }
      return new MailgunEmail(
        {
          apiKey: cfg.mailgun.apiKey,
          domain: cfg.mailgun.domain,
          baseUrl: cfg.mailgun.baseUrl,
        },
        deps,
      );
    case "mailjet":
      if (cfg.mailjet === undefined) {
        throw new Error("mailjet config is required when provider is 'mailjet'");
      }
      return new MailjetEmail(
        {
          apiKey: cfg.mailjet.apiKey,
          secretKey: cfg.mailjet.secretKey,
          baseUrl: cfg.mailjet.baseUrl,
        },
        deps,
      );
  }
}
