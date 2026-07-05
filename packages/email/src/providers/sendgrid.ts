import {
  makeObserver,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";
import type { Policy, RetryConfig } from "@primandproper/retry";

import {
  assertHasBody,
  type Email,
  type EmailMessage,
  type Recipients,
  type SendResult,
} from "../email.js";
import { senderInstruments, type SenderInstruments } from "../support.js";

import {
  DEFAULT_EMAIL_TIMEOUT_MS,
  recipientDomain,
  recipientList,
  requestIdFromHeaders,
  resilientFetch,
  resolveFetch,
  retryPolicy,
  type FetchLike,
} from "./http.js";

const o11yName = "email";

export interface SendgridEmailOptions {
  /** The SendGrid API key, sent as a bearer token. */
  apiKey: string;
  /** Overrides the API base URL. Defaults to `https://api.sendgrid.com`. */
  baseUrl?: string;
  /** Per-send deadline in milliseconds; `0` disables it. Defaults to 30s. */
  timeoutMs?: number;
  /** Optional retry policy for transient failures (network/timeout, 429/5xx). Off by default. */
  retry?: RetryConfig | undefined;
  /** The `fetch` implementation. Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
}

/**
 * An {@link Email} backed by the SendGrid v3 Mail Send API. POSTs to `/v3/mail/send` with a bearer
 * token. On success SendGrid returns `202` with no body and an `X-Message-Id` header, which becomes
 * the {@link SendResult.id}. A non-2xx response throws an Error carrying the status and body text.
 */
export class SendgridEmail implements Email {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #retry: Policy | undefined;
  readonly #observer: Observer;
  readonly #instruments: SenderInstruments;

  constructor(options: SendgridEmailOptions, deps: ObservabilityDeps = {}) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl ?? "https://api.sendgrid.com";
    this.#fetch = resolveFetch(options.fetch);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_EMAIL_TIMEOUT_MS;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#retry = retryPolicy(options.retry, this.#observer.logger());
    this.#instruments = senderInstruments(o11yName, deps);
  }

  send(message: EmailMessage): Promise<SendResult> {
    return this.#observer.run("send", async (op) => {
      assertHasBody(message);
      op.set("recipientDomain", recipientDomain(message.to));

      const response = await resilientFetch(
        (signal) =>
          this.#fetch(`${this.#baseUrl}/v3/mail/send`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.#apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(toSendgridPayload(message)),
            ...(signal === undefined ? {} : { signal }),
          }),
        { timeoutMs: this.#timeoutMs, retry: this.#retry },
      );

      if (!response.ok) {
        const body = await response.text();
        const requestId = requestIdFromHeaders(response.headers);
        if (requestId !== undefined) {
          op.set("requestId", requestId);
        }
        this.#instruments.errors.add(1);
        throw op.error(
          new Error(`sendgrid send failed: ${String(response.status)} ${body}`),
          `sendgrid send failed with status ${String(response.status)}`,
        );
      }

      const id = response.headers.get("x-message-id");
      if (id !== null) {
        op.set("requestId", id);
      }
      this.#instruments.sends.add(1);
      return id === null ? {} : { id };
    });
  }

  async ping(): Promise<void> {
    const response = await this.#fetch(`${this.#baseUrl}/v3/scopes`, {
      method: "GET",
      headers: { authorization: `Bearer ${this.#apiKey}` },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`sendgrid ping failed: ${String(response.status)} ${body}`);
    }
  }
}

interface SendgridAddress {
  email: string;
}

interface SendgridPersonalization {
  to: SendgridAddress[];
  cc?: SendgridAddress[];
  bcc?: SendgridAddress[];
}

interface SendgridContent {
  type: string;
  value: string;
}

interface SendgridPayload {
  personalizations: SendgridPersonalization[];
  from: SendgridAddress;
  subject: string;
  content: SendgridContent[];
  reply_to?: SendgridAddress;
}

function toAddresses(recipients: Recipients): SendgridAddress[] {
  return recipientList(recipients).map((email) => ({ email }));
}

/** Maps an {@link EmailMessage} to the SendGrid Mail Send request body. */
function toSendgridPayload(message: EmailMessage): SendgridPayload {
  const personalization: SendgridPersonalization = { to: toAddresses(message.to) };
  if (message.cc !== undefined) personalization.cc = toAddresses(message.cc);
  if (message.bcc !== undefined) personalization.bcc = toAddresses(message.bcc);

  const content: SendgridContent[] = [];
  if (message.text !== undefined)
    content.push({ type: "text/plain", value: message.text });
  if (message.html !== undefined)
    content.push({ type: "text/html", value: message.html });

  const payload: SendgridPayload = {
    personalizations: [personalization],
    from: { email: message.from },
    subject: message.subject,
    content,
  };
  if (message.replyTo !== undefined) payload.reply_to = { email: message.replyTo };
  return payload;
}
