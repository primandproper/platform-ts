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
  type SendResult,
} from "../email.js";

const o11yName = "email";

/** The slice of `fetch` the provider relies on. Injectable so tests need no network. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ResendEmailOptions {
  /** The Resend API key, sent as a bearer token. */
  apiKey: string;
  /** Overrides the API base URL. Defaults to `https://api.resend.com`. */
  baseUrl?: string;
  /** The `fetch` implementation. Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
}

/** The shape of the Resend create-email response we read. */
interface ResendSendResponse {
  id?: string;
}

/**
 * An {@link Email} backed by the Resend REST API. Zero-dependency: it POSTs to
 * `/emails` with the global `fetch` and a bearer token. A non-2xx response throws an Error
 * carrying the status and body text.
 */
export class ResendEmail implements Email {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(options: ResendEmailOptions, deps: ObservabilityDeps = {}) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl ?? "https://api.resend.com";
    if (options.fetch !== undefined) {
      this.#fetch = options.fetch;
    } else if (typeof globalThis.fetch === "function") {
      // Bind so the global fetch keeps its `this` when called as a bare reference.
      this.#fetch = globalThis.fetch.bind(globalThis);
    } else {
      throw new Error("no fetch implementation available; pass one via options.fetch");
    }
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  async send(message: EmailMessage): Promise<SendResult> {
    assertHasBody(message);

    const response = await this.#fetch(`${this.#baseUrl}/emails`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(toResendPayload(message)),
    });

    if (!response.ok) {
      const body = await response.text();
      this.#logger.error(`resend send failed with status ${String(response.status)}`);
      throw new Error(`resend send failed: ${String(response.status)} ${body}`);
    }

    const parsed = (await response.json()) as ResendSendResponse;
    return parsed.id === undefined ? {} : { id: parsed.id };
  }

  async ping(): Promise<void> {
    const response = await this.#fetch(`${this.#baseUrl}/emails`, {
      method: "OPTIONS",
      headers: { authorization: `Bearer ${this.#apiKey}` },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`resend ping failed: ${String(response.status)} ${body}`);
    }
  }
}

/** The Resend create-email request body. `reply_to` is Resend's snake_case spelling. */
interface ResendPayload {
  to: EmailMessage["to"];
  from: string;
  subject: string;
  text?: string;
  html?: string;
  cc?: EmailMessage["cc"];
  bcc?: EmailMessage["bcc"];
  reply_to?: string;
}

/** Maps an {@link EmailMessage} to the Resend create-email request body. */
function toResendPayload(message: EmailMessage): ResendPayload {
  const payload: ResendPayload = {
    to: message.to,
    from: message.from,
    subject: message.subject,
  };
  if (message.text !== undefined) {
    payload.text = message.text;
  }
  if (message.html !== undefined) {
    payload.html = message.html;
  }
  if (message.cc !== undefined) {
    payload.cc = message.cc;
  }
  if (message.bcc !== undefined) {
    payload.bcc = message.bcc;
  }
  if (message.replyTo !== undefined) {
    payload.reply_to = message.replyTo;
  }
  return payload;
}
