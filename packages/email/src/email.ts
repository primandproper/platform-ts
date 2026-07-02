import { PlatformError } from "@primandproper/errors";

/** A list of recipients, as a single address or several. */
export type Recipients = string | string[];

/**
 * An email to send. At least one of {@link EmailMessage.text} or {@link EmailMessage.html}
 * must be present — enforce it with {@link assertHasBody} before handing the message to a
 * transport.
 */
export interface EmailMessage {
  /** One or more recipient addresses. */
  to: Recipients;
  /** The sender address. */
  from: string;
  subject: string;
  /** The plain-text body. At least one of `text`/`html` is required. */
  text?: string;
  /** The HTML body. At least one of `text`/`html` is required. */
  html?: string;
  cc?: Recipients;
  bcc?: Recipients;
  replyTo?: string;
}

/** The outcome of a send. `id` is the provider's message identifier, when it returns one. */
export interface SendResult {
  id?: string;
}

/**
 * The email contract. {@link send} delivers a message; {@link ping} verifies the backing
 * transport is reachable. A provider may return an empty {@link SendResult} when it has no
 * identifier to report (e.g. the noop provider).
 */
export interface Email {
  send(message: EmailMessage): Promise<SendResult>;
  ping(): Promise<void>;
}

/** Thrown when a message carries neither a `text` nor an `html` body. */
export class EmptyEmailBodyError extends PlatformError {
  constructor() {
    super("email/empty-body", "email message must have a text or html body");
    this.name = "EmptyEmailBodyError";
  }
}

/**
 * Throws {@link EmptyEmailBodyError} unless the message has a non-empty `text` or `html`
 * body. Providers call this before dispatch so the requirement holds regardless of transport.
 */
export function assertHasBody(message: EmailMessage): void {
  if (
    (message.text === undefined || message.text === "") &&
    (message.html === undefined || message.html === "")
  ) {
    throw new EmptyEmailBodyError();
  }
}
