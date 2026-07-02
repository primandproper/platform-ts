import { PlatformError } from "@primandproper/errors";

/**
 * The secrets contract. A missing secret is `undefined` rather than a sentinel error — the
 * same idiomatic-TypeScript divergence the cache makes from Go's `(value, error)`. Use
 * {@link getRequired} at startup for secrets whose absence should be fatal.
 */
export interface SecretSource {
  /** Returns the secret's value, or `undefined` when it is not set. */
  get(key: string): Promise<string | undefined>;
  /** Like {@link get}, but throws {@link MissingSecretError} when the secret is absent. */
  getRequired(key: string): Promise<string>;
  /** Verifies the backing store is reachable. */
  ping(): Promise<void>;
}

/** Thrown by {@link SecretSource.getRequired} when a required secret is not set. */
export class MissingSecretError extends PlatformError {
  constructor(key: string) {
    super("secrets/missing", `required secret is not set: ${key}`);
    this.name = "MissingSecretError";
  }
}

/**
 * Default {@link SecretSource.getRequired} built on {@link SecretSource.get}, so providers
 * only implement the optional read and share identical required-secret semantics.
 */
export async function getRequired(
  source: Pick<SecretSource, "get">,
  key: string,
): Promise<string> {
  const value = await source.get(key);
  if (value === undefined) {
    throw new MissingSecretError(key);
  }
  return value;
}
