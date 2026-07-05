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
  parseJsonBody,
  recipientList,
  requestIdFromHeaders,
  resilientFetch,
  resolveFetch,
  retryPolicy,
  type FetchLike,
} from "./http.js";

const o11yName = "email";

export interface MailgunEmailOptions {
  /** The Mailgun private API key (used as the password in HTTP basic auth, user `api`). */
  apiKey: string;
  /** The sending domain, e.g. `mg.example.com`. */
  domain: string;
  /** Overrides the API base URL. Defaults to `https://api.mailgun.net` (use `api.eu.mailgun.net` for EU). */
  baseUrl?: string;
  /** Per-send deadline in milliseconds; `0` disables it. Defaults to 30s. */
  timeoutMs?: number;
  /** Optional retry policy for transient failures (network/timeout, 429/5xx). Off by default. */
  retry?: RetryConfig | undefined;
  /** The `fetch` implementation. Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
}

interface MailgunSendResponse {
  id?: string;
  message?: string;
}

/**
 * An {@link Email} backed by the Mailgun messages API. POSTs a form-encoded body to
 * `/v3/<domain>/messages` with HTTP basic auth (`api:<key>`). The returned message id becomes the
 * {@link SendResult.id}. A non-2xx response throws an Error carrying the status and body text.
 */
export class MailgunEmail implements Email {
  readonly #authorization: string;
  readonly #domain: string;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #retry: Policy | undefined;
  readonly #observer: Observer;
  readonly #instruments: SenderInstruments;

  constructor(options: MailgunEmailOptions, deps: ObservabilityDeps = {}) {
    this.#authorization = `Basic ${btoa(`api:${options.apiKey}`)}`;
    this.#domain = options.domain;
    this.#baseUrl = options.baseUrl ?? "https://api.mailgun.net";
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
          this.#fetch(`${this.#baseUrl}/v3/${this.#domain}/messages`, {
            method: "POST",
            headers: {
              authorization: this.#authorization,
              "content-type": "application/x-www-form-urlencoded",
            },
            body: toMailgunForm(message).toString(),
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
          new Error(`mailgun send failed: ${String(response.status)} ${body}`),
          `mailgun send failed with status ${String(response.status)}`,
        );
      }

      const parsed = (await parseJsonBody<MailgunSendResponse>(response)) ?? {};
      if (parsed.id !== undefined) {
        op.set("requestId", parsed.id);
      }
      this.#instruments.sends.add(1);
      return parsed.id === undefined ? {} : { id: parsed.id };
    });
  }

  async ping(): Promise<void> {
    const response = await this.#fetch(`${this.#baseUrl}/v3/domains`, {
      method: "GET",
      headers: { authorization: this.#authorization },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`mailgun ping failed: ${String(response.status)} ${body}`);
    }
  }
}

function appendRecipients(
  form: URLSearchParams,
  field: string,
  recipients: Recipients,
): void {
  for (const address of recipientList(recipients)) {
    form.append(field, address);
  }
}

/** Maps an {@link EmailMessage} to a Mailgun form-encoded body. */
function toMailgunForm(message: EmailMessage): URLSearchParams {
  const form = new URLSearchParams();
  form.set("from", message.from);
  appendRecipients(form, "to", message.to);
  form.set("subject", message.subject);
  if (message.text !== undefined) form.set("text", message.text);
  if (message.html !== undefined) form.set("html", message.html);
  if (message.cc !== undefined) appendRecipients(form, "cc", message.cc);
  if (message.bcc !== undefined) appendRecipients(form, "bcc", message.bcc);
  if (message.replyTo !== undefined) form.set("h:Reply-To", message.replyTo);
  return form;
}
