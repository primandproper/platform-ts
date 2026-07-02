import { z } from "zod";

/** Resend-provider config: an API key authenticates against the Resend REST API. */
export const ResendEmailConfigSchema = z.object({
  apiKey: z.string(),
  /** Overrides the API base URL. Defaults to Resend's public endpoint. */
  baseUrl: z.string().default("https://api.resend.com"),
});

export type ResendEmailConfig = z.infer<typeof ResendEmailConfigSchema>;

/** Postmark-provider config: a server API token authenticates the Postmark `ServerClient`. */
export const PostmarkEmailConfigSchema = z.object({
  serverToken: z.string(),
});

export type PostmarkEmailConfig = z.infer<typeof PostmarkEmailConfigSchema>;

/** SendGrid-provider config: an API key authenticates against the SendGrid v3 Mail Send API. */
export const SendgridEmailConfigSchema = z.object({
  apiKey: z.string(),
  baseUrl: z.string().default("https://api.sendgrid.com"),
});

export type SendgridEmailConfig = z.infer<typeof SendgridEmailConfigSchema>;

/** Mailgun-provider config: a private API key plus the sending domain. */
export const MailgunEmailConfigSchema = z.object({
  apiKey: z.string(),
  domain: z.string(),
  /** Defaults to the US endpoint; use `https://api.eu.mailgun.net` for the EU region. */
  baseUrl: z.string().default("https://api.mailgun.net"),
});

export type MailgunEmailConfig = z.infer<typeof MailgunEmailConfigSchema>;

/** Mailjet-provider config: an API key + secret key pair for HTTP basic auth. */
export const MailjetEmailConfigSchema = z.object({
  apiKey: z.string(),
  secretKey: z.string(),
  baseUrl: z.string().default("https://api.mailjet.com"),
});

export type MailjetEmailConfig = z.infer<typeof MailjetEmailConfigSchema>;

/**
 * Email config. Replaces the Go `env:`-tagged struct + ozzo `ValidateWithContext`. `noop`
 * (default) drops every send; `memory` captures sends for tests; `resend`, `sendgrid`, `mailgun`,
 * and `mailjet` deliver over their respective REST APIs; `postmark` delivers via the Postmark
 * `ServerClient` SDK. All real transports stay server-side.
 */
export const EmailConfigSchema = z
  .object({
    provider: z
      .enum(["noop", "memory", "resend", "postmark", "sendgrid", "mailgun", "mailjet"])
      .default("noop"),
    resend: ResendEmailConfigSchema.optional(),
    postmark: PostmarkEmailConfigSchema.optional(),
    sendgrid: SendgridEmailConfigSchema.optional(),
    mailgun: MailgunEmailConfigSchema.optional(),
    mailjet: MailjetEmailConfigSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    const requireSection = (
      provider: typeof cfg.provider,
      section: keyof typeof cfg,
    ): void => {
      if (cfg.provider === provider && cfg[section] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [section],
          message: `${provider} config is required when provider is '${provider}'`,
        });
      }
    };
    requireSection("resend", "resend");
    requireSection("postmark", "postmark");
    requireSection("sendgrid", "sendgrid");
    requireSection("mailgun", "mailgun");
    requireSection("mailjet", "mailjet");
  });

export type EmailConfig = z.infer<typeof EmailConfigSchema>;
export type EmailConfigInput = z.input<typeof EmailConfigSchema>;
