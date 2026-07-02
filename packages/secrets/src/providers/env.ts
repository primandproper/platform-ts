import {
  makeObserver,
  type Logger,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import { getRequired, type SecretSource } from "../secrets.js";

const o11yName = "secrets";

export interface EnvSecretSourceOptions {
  /** Prepended to every key before reading from the environment. */
  prefix?: string;
  /** The environment to read from. Defaults to `process.env`; injectable for tests. */
  env?: Record<string, string | undefined>;
}

/** Reads secrets from process environment variables. The default server-side provider. */
export class EnvSecretSource implements SecretSource {
  readonly #prefix: string;
  readonly #env: Record<string, string | undefined>;
  readonly #observer: Observer;
  readonly #logger: Logger;

  constructor(options: EnvSecretSourceOptions = {}, deps: ObservabilityDeps = {}) {
    this.#prefix = options.prefix ?? "";
    this.#env = options.env ?? process.env;
    this.#observer = deps.observer ?? makeObserver(o11yName, deps);
    this.#logger = this.#observer.logger();
  }

  get(key: string): Promise<string | undefined> {
    const value = this.#env[this.#prefix + key];
    if (value === undefined) {
      this.#logger.debug("secret not set");
    }
    return Promise.resolve(value);
  }

  getRequired(key: string): Promise<string> {
    return getRequired(this, key);
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }
}
