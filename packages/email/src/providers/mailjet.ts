import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import {
  assertHasBody,
  type Email,
  type EmailMessage,
  type Recipients,
  type SendResult,
} from "../email.js";

import { recipientList, resolveFetch, type FetchLike } from "./http.js";

const o11yName = "email";

export interface MailjetEmailOptions {
  /** The Mailjet API key (basic-auth username). */
  apiKey: string;
  /** The Mailjet secret key (basic-auth password). */
  secretKey: string;
  /** Overrides the API base URL. Defaults to `https://api.mailjet.com`. */
  baseUrl?: string;
  /** The `fetch` implementation. Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
}

interface MailjetSendResponse {
  Messages?: { To?: { MessageID?: number; MessageUUID?: string }[] }[];
}

/**
 * An {@link Email} backed by the Mailjet Send API v3.1. POSTs to `/v3.1/send` with HTTP basic auth
 * (`apiKey:secretKey`). The first recipient's `MessageUUID` (or `MessageID`) becomes the
 * {@link SendResult.id}. A non-2xx response throws an Error carrying the status and body text.
 */
export class MailjetEmail implements Email {
  readonly #authorization: string;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(options: MailjetEmailOptions, deps: ObservabilityDeps = {}) {
    this.#authorization = `Basic ${btoa(`${options.apiKey}:${options.secretKey}`)}`;
    this.#baseUrl = options.baseUrl ?? "https://api.mailjet.com";
    this.#fetch = resolveFetch(options.fetch);
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  async send(message: EmailMessage): Promise<SendResult> {
    assertHasBody(message);

    const response = await this.#fetch(`${this.#baseUrl}/v3.1/send`, {
      method: "POST",
      headers: {
        authorization: this.#authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify(toMailjetPayload(message)),
    });

    if (!response.ok) {
      const body = await response.text();
      this.#logger.error(`mailjet send failed with status ${String(response.status)}`);
      throw new Error(`mailjet send failed: ${String(response.status)} ${body}`);
    }

    const parsed = (await response.json()) as MailjetSendResponse;
    const recipient = parsed.Messages?.[0]?.To?.[0];
    const id =
      recipient?.MessageUUID ??
      (recipient?.MessageID !== undefined ? String(recipient.MessageID) : undefined);
    return id === undefined ? {} : { id };
  }

  async ping(): Promise<void> {
    const response = await this.#fetch(`${this.#baseUrl}/v3/REST/sender`, {
      method: "GET",
      headers: { authorization: this.#authorization },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`mailjet ping failed: ${String(response.status)} ${body}`);
    }
  }
}

interface MailjetAddress {
  Email: string;
}

interface MailjetMessage {
  From: MailjetAddress;
  To: MailjetAddress[];
  Subject: string;
  TextPart?: string;
  HTMLPart?: string;
  Cc?: MailjetAddress[];
  Bcc?: MailjetAddress[];
  ReplyTo?: MailjetAddress;
}

function toAddresses(recipients: Recipients): MailjetAddress[] {
  return recipientList(recipients).map((email) => ({ Email: email }));
}

/** Maps an {@link EmailMessage} to the Mailjet Send v3.1 request body. */
function toMailjetPayload(message: EmailMessage): { Messages: MailjetMessage[] } {
  const entry: MailjetMessage = {
    From: { Email: message.from },
    To: toAddresses(message.to),
    Subject: message.subject,
  };
  if (message.text !== undefined) entry.TextPart = message.text;
  if (message.html !== undefined) entry.HTMLPart = message.html;
  if (message.cc !== undefined) entry.Cc = toAddresses(message.cc);
  if (message.bcc !== undefined) entry.Bcc = toAddresses(message.bcc);
  if (message.replyTo !== undefined) entry.ReplyTo = { Email: message.replyTo };
  return { Messages: [entry] };
}
