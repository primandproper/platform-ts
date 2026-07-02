import { wrap } from "@primandproper/errors";
import {
  makeObserver,
  type Logger,
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
  readonly #logger: Logger;

  constructor(options: PostmarkEmailOptions, deps: ObservabilityDeps = {}) {
    this.#client = options.client ?? new ServerClient(options.serverToken);
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  async send(message: EmailMessage): Promise<SendResult> {
    assertHasBody(message);

    let response: PostmarkSendResponse;
    try {
      response = await this.#client.sendEmail(toPostmarkMessage(message));
    } catch (cause) {
      this.#logger.error("postmark send failed");
      throw wrap("postmark send failed", cause);
    }

    if (response.ErrorCode !== undefined && response.ErrorCode !== 0) {
      const detail = response.Message ?? "no message";
      this.#logger.error(
        `postmark send returned error code ${String(response.ErrorCode)}`,
      );
      throw new Error(`postmark send failed: ${String(response.ErrorCode)} ${detail}`);
    }

    return response.MessageID === undefined ? {} : { id: response.MessageID };
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
