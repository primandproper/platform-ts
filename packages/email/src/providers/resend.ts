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
  type SendResult,
} from "../email.js";
import { senderInstruments, type SenderInstruments } from "../support.js";

import {
  DEFAULT_EMAIL_TIMEOUT_MS,
  type FetchLike,
  parseJsonBody,
  recipientDomain,
  requestIdFromHeaders,
  resilientFetch,
  retryPolicy,
} from "./http.js";

const o11yName = "email";

export interface ResendEmailOptions {
  /** The Resend API key, sent as a bearer token. */
  apiKey: string;
  /** Overrides the API base URL. Defaults to `https://api.resend.com`. */
  baseUrl?: string;
  /** Per-send deadline in milliseconds; `0` disables it. Defaults to 30s. */
  timeoutMs?: number;
  /** Optional retry policy for transient failures (network/timeout, 429/5xx). Off by default. */
  retry?: RetryConfig | undefined;
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
  readonly #timeoutMs: number;
  readonly #retry: Policy | undefined;
  readonly #observer: Observer;
  readonly #instruments: SenderInstruments;

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
          this.#fetch(`${this.#baseUrl}/emails`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.#apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(toResendPayload(message)),
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
          new Error(`resend send failed: ${String(response.status)} ${body}`),
          `resend send failed with status ${String(response.status)}`,
        );
      }

      const parsed = (await parseJsonBody<ResendSendResponse>(response)) ?? {};
      if (parsed.id !== undefined) {
        op.set("requestId", parsed.id);
      }
      this.#instruments.sends.add(1);
      return parsed.id === undefined ? {} : { id: parsed.id };
    });
  }

  async ping(): Promise<void> {
    // A real authenticated health check: GET /domains exercises the API key against a documented
    // read-only endpoint (the old OPTIONS /emails probe hit an undocumented, unauthenticated path
    // that could "succeed" with an invalid key).
    const response = await this.#fetch(`${this.#baseUrl}/domains`, {
      method: "GET",
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
