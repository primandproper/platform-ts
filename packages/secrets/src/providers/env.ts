import {
  makeObserver,
  type ObservabilityDeps,
  type Observer,
} from "@primandproper/observability";

import { getRequired, type SecretSource } from "../secrets.js";

import { SECRET_KEY, secretInstruments, type SecretInstruments } from "./support.js";

const sourceName = "env_secret_source";

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
  readonly #instruments: SecretInstruments;

  constructor(options: EnvSecretSourceOptions = {}, deps: ObservabilityDeps = {}) {
    this.#prefix = options.prefix ?? "";
    this.#env = options.env ?? process.env;
    this.#observer = deps.observer ?? makeObserver(sourceName, deps);
    this.#instruments = secretInstruments(deps, sourceName);
  }

  get(key: string): Promise<string | undefined> {
    return this.#observer.run("get_secret", (op) => {
      const start = performance.now();
      try {
        const name = this.#prefix + key;
        // NOTE: only the lookup key is observed, never the secret's value.
        op.set(SECRET_KEY, name);
        this.#instruments.lookups.add(1);

        const value = this.#env[name];
        if (value === undefined) {
          op.logger().debug("secret not set");
        }
        return value;
      } finally {
        this.#instruments.latency.record(performance.now() - start);
      }
    });
  }

  getRequired(key: string): Promise<string> {
    return getRequired(this, key);
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.#observer.logger().debug("closing env secret source");
    return Promise.resolve();
  }
}
