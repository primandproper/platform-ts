import { getRequired, type SecretSource } from "../secrets.js";

/** A {@link SecretSource} that knows no secrets; every lookup is a miss. */
export class NoopSecretSource implements SecretSource {
  get(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }

  getRequired(key: string): Promise<string> {
    return getRequired(this, key);
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
