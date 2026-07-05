import { wrap } from "@primandproper/errors";
import {
  makeObserver,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";
import { ServerClient } from "postmark";

import {
  assertHasBody,
  type Email,
  type EmailMessage,
  type SendResult,
} from "../email.js";
import { senderInstruments, type SenderInstruments } from "../support.js";

import { recipientDomain } from "./http.js";

const o11yName = "email";

/** The slice of the Postmark `ServerClient` the provider relies on. Injectable for tests. */
export interface PostmarkClientLike {
  sendEmail(message: PostmarkMessage): Promise<PostmarkSendResponse>;
  getServer(): Promise<unknown>;
}

export interface PostmarkEmailOptions {
  /** The Postmark server API token, passed to the `ServerClient`. */
  serverToken: string;
  /**
   * The Postmark client. Defaults to a real `ServerClient` built from `serverToken`. Inject
   * a fake in tests so no network call is made.
   */
  client?: PostmarkClientLike;
}

/** The subset of Postmark's send-email request we populate. Postmark uses PascalCase fields. */
export interface PostmarkMessage {
  From: string;
  To: string;
  Subject: string;
  TextBody?: string;
  HtmlBody?: string;
  Cc?: string;
  Bcc?: string;
  ReplyTo?: string;
}

/** The slice of Postmark's send-email response we read. */
export interface PostmarkSendResponse {
  MessageID?: string;
  ErrorCode?: number;
  Message?: string;
}

/**
 * An {@link Email} backed by the Postmark `ServerClient` SDK. A non-zero `ErrorCode` in the
 * response, or any error thrown by the SDK, is wrapped in an Error carrying Postmark's context.
 */
export class PostmarkEmail implements Email {
  readonly #client: PostmarkClientLike;
  readonly #observer: Observer;
  readonly #instruments: SenderInstruments;

  constructor(options: PostmarkEmailOptions, deps: ObservabilityDeps = {}) {
    this.#client = options.client ?? new ServerClient(options.serverToken);
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#instruments = senderInstruments(o11yName, deps);
  }

  send(message: EmailMessage): Promise<SendResult> {
    return this.#observer.run("send", async (op) => {
      assertHasBody(message);
      op.set("recipientDomain", recipientDomain(message.to));

      let response: PostmarkSendResponse;
      try {
        response = await this.#client.sendEmail(toPostmarkMessage(message));
      } catch (cause) {
        this.#instruments.errors.add(1);
        throw op.error(wrap("postmark send failed", cause), "postmark send failed");
      }

      if (response.ErrorCode !== undefined && response.ErrorCode !== 0) {
        const detail = response.Message ?? "no message";
        this.#instruments.errors.add(1);
        throw op.error(
          new Error(`postmark send failed: ${String(response.ErrorCode)} ${detail}`),
          `postmark send returned error code ${String(response.ErrorCode)}`,
        );
      }

      if (response.MessageID !== undefined) {
        op.set("requestId", response.MessageID);
      }
      this.#instruments.sends.add(1);
      return response.MessageID === undefined ? {} : { id: response.MessageID };
    });
  }

  async ping(): Promise<void> {
    try {
      await this.#client.getServer();
    } catch (cause) {
      throw wrap("postmark ping failed", cause);
    }
  }
}

/** Recipient lists are arrays or single strings; Postmark wants a comma-separated string. */
function joinRecipients(recipients: EmailMessage["to"]): string {
  return Array.isArray(recipients) ? recipients.join(", ") : recipients;
}

/** Maps an {@link EmailMessage} to Postmark's send-email request body. */
function toPostmarkMessage(message: EmailMessage): PostmarkMessage {
  const payload: PostmarkMessage = {
    From: message.from,
    To: joinRecipients(message.to),
    Subject: message.subject,
  };
  if (message.text !== undefined) {
    payload.TextBody = message.text;
  }
  if (message.html !== undefined) {
    payload.HtmlBody = message.html;
  }
  if (message.cc !== undefined) {
    payload.Cc = joinRecipients(message.cc);
  }
  if (message.bcc !== undefined) {
    payload.Bcc = joinRecipients(message.bcc);
  }
  if (message.replyTo !== undefined) {
    payload.ReplyTo = message.replyTo;
  }
  return payload;
}
