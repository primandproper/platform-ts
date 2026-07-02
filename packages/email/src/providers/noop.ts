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

/** An {@link Email} that delivers nothing; it logs at debug and returns an empty result. */
export class NoopEmail implements Email {
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(deps: ObservabilityDeps = {}) {
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  async send(message: EmailMessage): Promise<SendResult> {
    assertHasBody(message);
    this.#logger.debug("email send is a noop");
    return {};
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }
}
