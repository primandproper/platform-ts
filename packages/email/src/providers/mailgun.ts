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

export interface MailgunEmailOptions {
  /** The Mailgun private API key (used as the password in HTTP basic auth, user `api`). */
  apiKey: string;
  /** The sending domain, e.g. `mg.example.com`. */
  domain: string;
  /** Overrides the API base URL. Defaults to `https://api.mailgun.net` (use `api.eu.mailgun.net` for EU). */
  baseUrl?: string;
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
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(options: MailgunEmailOptions, deps: ObservabilityDeps = {}) {
    this.#authorization = `Basic ${btoa(`api:${options.apiKey}`)}`;
    this.#domain = options.domain;
    this.#baseUrl = options.baseUrl ?? "https://api.mailgun.net";
    this.#fetch = resolveFetch(options.fetch);
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  async send(message: EmailMessage): Promise<SendResult> {
    assertHasBody(message);

    const response = await this.#fetch(`${this.#baseUrl}/v3/${this.#domain}/messages`, {
      method: "POST",
      headers: {
        authorization: this.#authorization,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: toMailgunForm(message).toString(),
    });

    if (!response.ok) {
      const body = await response.text();
      this.#logger.error(`mailgun send failed with status ${String(response.status)}`);
      throw new Error(`mailgun send failed: ${String(response.status)} ${body}`);
    }

    const parsed = (await response.json()) as MailgunSendResponse;
    return parsed.id === undefined ? {} : { id: parsed.id };
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
