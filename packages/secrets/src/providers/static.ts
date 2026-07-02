import { getRequired, type SecretSource } from "../secrets.js";

export interface StaticSecretSourceOptions {
  values?: Record<string, string>;
}

/**
 * Serves secrets from an inline map. Useful for tests and for wiring secrets that already
 * live in validated config. Universal logic, but the package is server-only by modality.
 */
export class StaticSecretSource implements SecretSource {
  readonly #values: Record<string, string>;

  constructor(options: StaticSecretSourceOptions = {}) {
    this.#values = { ...options.values };
  }

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(
      Object.prototype.hasOwnProperty.call(this.#values, key)
        ? this.#values[key]
        : undefined,
    );
  }

  getRequired(key: string): Promise<string> {
    return getRequired(this, key);
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }
}
