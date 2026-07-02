import {
  assertHasBody,
  type Email,
  type EmailMessage,
  type SendResult,
} from "../email.js";

/**
 * An {@link Email} that captures every send in memory rather than delivering it. Useful for
 * tests: assert against {@link MemoryEmail.sent}. Universal logic, but the package is
 * server-only by modality.
 */
export class MemoryEmail implements Email {
  /** Every message passed to {@link send}, in order. Readable for assertions. */
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<SendResult> {
    assertHasBody(message);
    this.sent.push(message);
    return { id: String(this.sent.length) };
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }
}
